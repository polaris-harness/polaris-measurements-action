# Polaris Measurements Action

[![Unit tests](https://github.com/claudioed/polaris-measurements-action/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/claudioed/polaris-measurements-action/actions/workflows/unit-tests.yml)

A GitHub Action that submits a CI run's measurements to a [Polaris](https://github.com/claudioed/polaris)
fitness function through the measurement-submission endpoint and turns the
evaluation outcome into a step result.

```yaml
- name: Submit measurements to Polaris
  uses: claudioed/polaris-measurements-action@v1
  with:
    polaris-url: https://polaris.example.com
    fitness-function-id: 01984361-4f3a-7abc-9f0e-2b2a6d5f1c22
    producer-id: 01984361-4f3a-7abc-9f0e-2b2a6d5f1c23
    fitness-function-version: 1
    measurements: '[{"criterionKey": "latency", "value": 120, "unit": "ms"}]'
  env:
    POLARIS_INGEST_SECRET_KEY: ${{ secrets.POLARIS_INGEST_SECRET_KEY }}
```

## Authentication

The action authenticates with the shared ingest secret via the `POLARIS_INGEST_SECRET_KEY`
environment variable — the same `X-API-Key` accepted by Polaris only on the
measurement-submission endpoints. Business endpoints use Google OpenID Connect and
never accept this key.

- Store the key as a repository/organization secret and map it into the step `env` (as above).
- The action fails fast when the variable is missing, masks the value in logs, and never
  echoes it in error messages.
- A 401 from Polaris means the key is wrong or not the ingest key configured with
  `POLARIS_INGEST_SECRET_KEY` on the server.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `polaris-url` | yes | – | Base URL of the Polaris control plane. The action appends the API path itself. |
| `fitness-function-id` | yes | – | UUID of the fitness function. |
| `producer-id` | yes | – | UUID of the registered measurement producer this run submits as. Must be the producer declared by the active definition. |
| `fitness-function-version` | no | `1` | Active version the measurements were produced against. |
| `measurements` | one of | – | Inline JSON array: `[{"criterionKey": "...", "value": 1, "unit": "..."}]`. |
| `measurements-file` | one of | – | Path to a JSON file containing the array, written by an earlier step. |
| `measurements-config` | one of | – | Path to a YAML/JSON config that *discovers* measurements from files already in the workspace instead of hand-computing them. See below. |
| `external-run-id` | no | `github-<run id>-attempt-<attempt>` | Producer-scoped run identifier. Submissions are deduplicated server-side by `producerId` + `externalRunId`. |
| `observed-at` | no | now (UTC) | RFC3339 timestamp of the measurements. Must be within the definition's maximum observation age. |
| `evidence` | no | `[]` | JSON array of evidence documents retained with the submission. |
| `timeout-seconds` | no | `30` | Per-attempt request timeout. |
| `max-attempts` | no | `3` | Attempts for transient failures (network errors, 502/503/504). 4xx responses are never retried. |
| `fail-on` | no | `fail` | Exit policy, see below. |

`measurements`, `measurements-file`, and `measurements-config` are mutually exclusive; exactly
one must be provided. Measurements are validated locally (non-empty, finite values, unique
criterion keys) before any network call.

## Outputs

| Output | Description |
| --- | --- |
| `evaluation-id` | UUID of the recorded evaluation. |
| `outcome` | `PASS`, `WARN`, `FAIL`, `ERROR`, or `NOT_APPLICABLE`. |
| `disposition` | `ACCEPTED`, `ATTENTION_REQUIRED`, `BLOCKED`, or `WAIVED`. |
| `replayed` | `true` when Polaris deduplicated a redelivery and returned the original evaluation. |

## Exit policy

| `fail-on` | PASS | WARN | FAIL |
| --- | --- | --- | --- |
| `never` | success | success (warning annotation) | success (error annotation) |
| `warn` | success | **fails** | **fails** |
| `fail` (default) | success | success (warning annotation) | **fails** |

`ERROR` (evaluation could not complete) always fails the step; `NOT_APPLICABLE` never does.
Retries are safe: the server deduplicates on `producerId` + `externalRunId`, so re-running
the step returns the original evaluation with `replayed: true`.

## Producing measurements from a file

```yaml
- name: Extract metrics
  run: |
    echo '[{"criterionKey":"request_failure_rate","value":0.8,"unit":"PERCENT"}]' > measurements.json
- uses: claudioed/polaris-measurements-action@v1
  with:
    polaris-url: ${{ vars.POLARIS_URL }}
    fitness-function-id: ${{ vars.POLARIS_FITNESS_FUNCTION_ID }}
    producer-id: ${{ vars.POLARIS_PRODUCER_ID }}
    measurements-file: measurements.json
    fail-on: warn
  env:
    POLARIS_INGEST_SECRET_KEY: ${{ secrets.POLARIS_INGEST_SECRET_KEY }}
```

## Discovering measurements automatically

Hand-computing each `criterionKey`/`value` pair gets painful fast: a typical pipeline spreads
coverage, lint, vulnerability, mutation, and container-scan numbers across a dozen jobs, each
printing its result to a log instead of exporting it anywhere a later step can read. `measurements-config`
removes the hand-coding by declaring, per criterion, which *file* holds the number and which of four
generic *shapes* it's in. The action knows nothing about Go, golangci-lint, govulncheck, gremlins, or
Trivy specifically — only these four shapes — so adding a new tool to a pipeline is a config edit,
never a code change here:

| `source.type` | Shape | Use for |
| --- | --- | --- |
| `regex` | First capture group of a pattern matched against a text file | Any tool's plain-text log/summary that prints the number inline (`go tool cover -func`, `govulncheck` text output, a custom shell script) |
| `json-path` | A single value at a dot/bracket path in a JSON file (`a.b[0].c`, leading `$.` optional) | A tool that already emits structured JSON with the number as a field (a gremlins report's `efficacy`, a custom metrics file) |
| `json-count` | The length of a JSON array at a path | Counting findings in a JSON report (`govulncheck -json`'s `Vulns` array) |
| `sarif-count` | Count of SARIF `results` at or above a severity (`note`/`warning`/`error`, default `warning`), optionally filtered by `ruleIds` | Any SARIF-emitting scanner (Trivy, CodeQL, Semgrep) |

Each measurement is `required: true` by default: if its file is missing or its pattern/path
doesn't resolve, the action fails with every missing criterion listed in one error (not one
push-and-fail-again cycle per criterion). Set `required: false` for a measurement that's only
produced sometimes (e.g. a mutation report from a weekly-only job) — when it can't be resolved
it's dropped silently from the submission and reported as a step warning instead of failing the run.

Because every file this reads was produced by *other* jobs in the workflow, the usual shape is:
have each producing job upload its raw report as a workflow artifact, then a final job downloads
them all and runs this action once with `measurements-config` pointed at a config checked into the
repo (e.g. `.polaris/measurements.yml`):

```yaml
# .polaris/measurements.yml
measurements:
  - criterionKey: coverage
    unit: PERCENT
    source:
      type: regex
      file: coverage-summary.txt
      pattern: 'total:\s+\(statements\)\s+([0-9.]+)%'

  - criterionKey: vulnerabilities
    unit: COUNT
    source:
      type: json-count
      file: govulncheck.json
      path: Vulns

  - criterionKey: trivy_critical_high
    unit: COUNT
    source:
      type: sarif-count
      file: trivy-results.sarif
      minLevel: error

  - criterionKey: mutation_efficacy
    unit: PERCENT
    required: false # only produced by the weekly/manual full mutation run
    source:
      type: json-path
      file: gremlins-report.json
      path: efficacy
```

```yaml
# .github/workflows/ci.yml, each producing job:
  test:
    steps:
      - run: go test ./... -coverprofile=coverage.out
      - run: go tool cover -func=coverage.out | grep '^total:' > coverage-summary.txt
      - uses: actions/upload-artifact@v4
        with: { name: coverage-summary, path: coverage-summary.txt }

  vuln:
    steps:
      - run: govulncheck -json ./... > govulncheck.json
      - uses: actions/upload-artifact@v4
        with: { name: govulncheck-report, path: govulncheck.json }

  trivy-scan:
    steps:
      - uses: aquasecurity/trivy-action@...
        with: { format: sarif, output: trivy-results.sarif }
      - uses: actions/upload-artifact@v4
        with: { name: trivy-report, path: trivy-results.sarif }

# and a final aggregator job that actually submits to Polaris:
  measurements:
    needs: [test, vuln, trivy-scan]
    if: always() # a FAIL evaluation in Polaris is the signal of record — don't suppress it
    steps:
      - uses: actions/checkout@v5 # for .polaris/measurements.yml
      - uses: actions/download-artifact@v4
        with: { pattern: '*', merge-multiple: true }
      - uses: claudioed/polaris-measurements-action@v1
        with:
          polaris-url: ${{ vars.POLARIS_URL }}
          fitness-function-id: ${{ vars.POLARIS_FITNESS_FUNCTION_ID }}
          producer-id: ${{ vars.POLARIS_PRODUCER_ID }}
          measurements-config: .polaris/measurements.yml
        env:
          POLARIS_INGEST_SECRET_KEY: ${{ secrets.POLARIS_INGEST_SECRET_KEY }}
```

`file` paths are resolved relative to the job's working directory (an absolute path is used
as-is), so point them at wherever `download-artifact` put the reports. The same four source
types work for any language or toolchain — nothing here is Go- or GitHub-Actions-tool-specific.

## Development

```sh
npm ci
npm run test            # vitest unit + local-server e2e suites
npm run test:coverage   # same suites with a 90% coverage floor on src/
npm run lint            # eslint, zero warnings allowed
npm run build           # tsc --noEmit then ncc bundle into dist/
```

`dist/index.js` is the committed bundle referenced by `action.yml`; rebuild and commit it
whenever `src/` changes. The action runs on the `node24` runtime.
