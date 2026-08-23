# Polaris Measurements Action

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
| `external-run-id` | no | `github-<run id>-attempt-<attempt>` | Producer-scoped run identifier. Submissions are deduplicated server-side by `producerId` + `externalRunId`. |
| `observed-at` | no | now (UTC) | RFC3339 timestamp of the measurements. Must be within the definition's maximum observation age. |
| `evidence` | no | `[]` | JSON array of evidence documents retained with the submission. |
| `timeout-seconds` | no | `30` | Per-attempt request timeout. |
| `max-attempts` | no | `3` | Attempts for transient failures (network errors, 502/503/504). 4xx responses are never retried. |
| `fail-on` | no | `fail` | Exit policy, see below. |

`measurements` and `measurements-file` are mutually exclusive; exactly one must be provided.
Measurements are validated locally (non-empty, finite values, unique criterion keys) before
any network call.

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

## Development

```sh
npm ci
npm run test       # vitest unit + local-server e2e suites
npm run lint       # eslint, zero warnings allowed
npm run build      # tsc --noEmit then ncc bundle into dist/
```

`dist/index.js` is the committed bundle referenced by `action.yml`; rebuild and commit it
whenever `src/` changes. The action runs on the `node24` runtime.
