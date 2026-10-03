import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMeasurementsConfig, extractMeasurements, resolvePath, ConfigError } from "../src/extract";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polaris-extract-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = join(dir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

describe("loadMeasurementsConfig", () => {
  it("rejects a missing config file", () => {
    expect(() => loadMeasurementsConfig(join(dir, "missing.yml"))).toThrowError(/does not exist/);
  });

  it("rejects invalid YAML/JSON", () => {
    const file = write("bad.yml", "measurements: [this is: not: valid");
    expect(() => loadMeasurementsConfig(file)).toThrowError(ConfigError);
  });

  it("rejects a config with no measurements", () => {
    const file = write("empty.yml", "measurements: []");
    expect(() => loadMeasurementsConfig(file)).toThrowError(/at least one measurement/);
  });

  it("rejects an unknown source type", () => {
    const file = write(
      "bad-type.yml",
      "measurements:\n  - criterionKey: a\n    unit: COUNT\n    source: { type: made-up, file: x.json }\n",
    );
    expect(() => loadMeasurementsConfig(file)).toThrowError(/invalid/);
  });

  it("rejects duplicate criterionKeys", () => {
    const file = write(
      "dup.yml",
      [
        "measurements:",
        "  - criterionKey: a",
        "    unit: COUNT",
        "    source: { type: json-count, file: x.json }",
        "  - criterionKey: a",
        "    unit: COUNT",
        "    source: { type: json-count, file: y.json }",
      ].join("\n"),
    );
    expect(() => loadMeasurementsConfig(file)).toThrowError(/duplicate criterionKey/);
  });

  it("parses a well-formed YAML config and applies source defaults", () => {
    const file = write(
      "ok.yml",
      ["measurements:", "  - criterionKey: coverage", "    unit: PERCENT", "    source: { type: regex, file: cov.txt, pattern: '(\\d+)' }"].join(
        "\n",
      ),
    );
    const config = loadMeasurementsConfig(file);
    expect(config.measurements[0].required).toBe(true);
    expect(config.measurements[0].source).toMatchObject({ group: 1, flags: "" });
  });

  it("also accepts plain JSON (a valid YAML subset)", () => {
    const file = write(
      "ok.json",
      JSON.stringify({ measurements: [{ criterionKey: "a", unit: "COUNT", source: { type: "json-count", file: "x.json" } }] }),
    );
    expect(loadMeasurementsConfig(file).measurements).toHaveLength(1);
  });
});

describe("resolvePath", () => {
  const doc = { a: { b: [{ c: 42 }, { c: 7 }] }, top: [1, 2, 3] };

  it("resolves dotted and bracketed segments, with or without a leading $", () => {
    expect(resolvePath(doc, "a.b[0].c")).toBe(42);
    expect(resolvePath(doc, "$.a.b[0].c")).toBe(42);
    expect(resolvePath(doc, "$.a.b.1.c")).toBe(7);
    expect(resolvePath(doc, "$")).toBe(doc);
    expect(resolvePath(doc, "$[0]".replace("[0]", ""))).toBe(doc);
  });

  it("returns undefined when a segment is missing or the value is not an object", () => {
    expect(resolvePath(doc, "a.missing.c")).toBeUndefined();
    expect(resolvePath(doc, "a.b[0].c.d")).toBeUndefined();
    expect(resolvePath(null, "a.b")).toBeUndefined();
  });

  it("indexes top-level arrays", () => {
    expect(resolvePath(doc, "top[2]")).toBe(3);
  });
});

describe("extractMeasurements", () => {
  it("extracts a number via a regex capture group from a text log", () => {
    write("coverage.txt", "total:\t(statements)\t87.5%\n");
    const config = loadMeasurementsConfig(
      write(
        "cfg.yml",
        [
          "measurements:",
          "  - criterionKey: coverage",
          "    unit: PERCENT",
          "    source:",
          "      type: regex",
          "      file: coverage.txt",
          "      pattern: 'total:\\s+\\(statements\\)\\s+([0-9.]+)%'",
        ].join("\n"),
      ),
    );
    const { measurements, skipped } = extractMeasurements(config, dir);
    expect(measurements).toEqual([{ criterionKey: "coverage", value: 87.5, unit: "PERCENT" }]);
    expect(skipped).toEqual([]);
  });

  it("extracts a number via json-path, including a numeric string", () => {
    write("report.json", JSON.stringify({ efficacy: 91.2, nested: { score: "88" } }));
    const config = loadMeasurementsConfig(
      write(
        "cfg.yml",
        [
          "measurements:",
          "  - criterionKey: mutation_efficacy",
          "    unit: PERCENT",
          "    source: { type: json-path, file: report.json, path: efficacy }",
          "  - criterionKey: nested_score",
          "    unit: PERCENT",
          "    source: { type: json-path, file: report.json, path: nested.score }",
        ].join("\n"),
      ),
    );
    const { measurements } = extractMeasurements(config, dir);
    expect(measurements).toEqual([
      { criterionKey: "mutation_efficacy", value: 91.2, unit: "PERCENT" },
      { criterionKey: "nested_score", value: 88, unit: "PERCENT" },
    ]);
  });

  it("counts a JSON array with json-count", () => {
    write("govulncheck.json", JSON.stringify({ Vulns: [{ id: "GO-1" }, { id: "GO-2" }] }));
    const config = loadMeasurementsConfig(
      write(
        "cfg.yml",
        ["measurements:", "  - criterionKey: vulnerabilities", "    unit: COUNT", "    source: { type: json-count, file: govulncheck.json, path: Vulns }"].join(
          "\n",
        ),
      ),
    );
    expect(extractMeasurements(config, dir).measurements).toEqual([{ criterionKey: "vulnerabilities", value: 2, unit: "COUNT" }]);
  });

  it("counts SARIF results at or above a severity level, honoring default level and ruleIds", () => {
    write(
      "trivy.sarif",
      JSON.stringify({
        runs: [
          {
            results: [
              { level: "error", ruleId: "CVE-1" },
              { level: "warning", ruleId: "CVE-2" },
              { ruleId: "CVE-3" }, // no level -> defaults to "warning" per SARIF spec
              { level: "note", ruleId: "CVE-4" },
            ],
          },
        ],
      }),
    );
    const highOnly = loadMeasurementsConfig(
      write(
        "cfg-high.yml",
        ["measurements:", "  - criterionKey: trivy_high", "    unit: COUNT", "    source: { type: sarif-count, file: trivy.sarif, minLevel: error }"].join(
          "\n",
        ),
      ),
    );
    expect(extractMeasurements(highOnly, dir).measurements[0].value).toBe(1);

    const warningAndUp = loadMeasurementsConfig(
      write(
        "cfg-warn.yml",
        ["measurements:", "  - criterionKey: trivy_warn", "    unit: COUNT", "    source: { type: sarif-count, file: trivy.sarif }"].join("\n"),
      ),
    );
    expect(extractMeasurements(warningAndUp, dir).measurements[0].value).toBe(3);

    const filteredByRule = loadMeasurementsConfig(
      write(
        "cfg-rule.yml",
        [
          "measurements:",
          "  - criterionKey: trivy_rule",
          "    unit: COUNT",
          "    source: { type: sarif-count, file: trivy.sarif, minLevel: note, ruleIds: [CVE-1, CVE-4] }",
        ].join("\n"),
      ),
    );
    expect(extractMeasurements(filteredByRule, dir).measurements[0].value).toBe(2);
  });

  it("rejects a document that is not SARIF-shaped", () => {
    write("not-sarif.json", JSON.stringify({ hello: "world" }));
    const config = loadMeasurementsConfig(
      write("cfg.yml", ["measurements:", "  - criterionKey: a", "    unit: COUNT", "    source: { type: sarif-count, file: not-sarif.json }"].join("\n")),
    );
    expect(() => extractMeasurements(config, dir)).toThrowError(/does not look like a SARIF document/);
  });

  it("tolerates a SARIF run with no results", () => {
    write("sparse.sarif", JSON.stringify({ runs: [{}] }));
    const config = loadMeasurementsConfig(
      write("cfg.yml", ["measurements:", "  - criterionKey: a", "    unit: COUNT", "    source: { type: sarif-count, file: sparse.sarif }"].join("\n")),
    );
    expect(extractMeasurements(config, dir).measurements[0].value).toBe(0);
  });

  it("aggregates every required failure into a single ConfigError", () => {
    const config = loadMeasurementsConfig(
      write(
        "cfg.yml",
        [
          "measurements:",
          "  - criterionKey: missing_a",
          "    unit: COUNT",
          "    source: { type: json-count, file: absent-a.json }",
          "  - criterionKey: missing_b",
          "    unit: COUNT",
          "    source: { type: json-count, file: absent-b.json }",
        ].join("\n"),
      ),
    );
    let message = "";
    try {
      extractMeasurements(config, dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("missing_a");
    expect(message).toContain("missing_b");
    expect(message).toMatch(/could not discover 2 required measurement/);
  });

  it("drops a failed optional measurement into skipped instead of throwing", () => {
    const config = loadMeasurementsConfig(
      write(
        "cfg.yml",
        [
          "measurements:",
          "  - criterionKey: weekly_mutation",
          "    unit: PERCENT",
          "    required: false",
          "    source: { type: json-path, file: absent.json, path: efficacy }",
        ].join("\n"),
      ),
    );
    const { measurements, skipped } = extractMeasurements(config, dir);
    expect(measurements).toEqual([]);
    expect(skipped).toEqual([{ criterionKey: "weekly_mutation", required: false, reason: expect.stringContaining("file not found") }]);
  });

  it("reports a clear reason for each failure shape", () => {
    write("plain.txt", "no numbers here");
    write("array.json", JSON.stringify([1, 2, 3]));
    write("object.json", JSON.stringify({ count: "not-a-number" }));
    const cases: Array<[string, string]> = [
      [
        ["measurements:", "  - criterionKey: a", "    unit: COUNT", "    source: { type: regex, file: plain.txt, pattern: '(\\d+)' }"].join("\n"),
        "did not match",
      ],
      [
        ["measurements:", "  - criterionKey: a", "    unit: COUNT", "    source: { type: json-path, file: object.json, path: count }"].join("\n"),
        "did not resolve to a number",
      ],
      [
        ["measurements:", "  - criterionKey: a", "    unit: COUNT", "    source: { type: json-count, file: object.json, path: count }"].join("\n"),
        "did not resolve to an array",
      ],
      [
        ["measurements:", "  - criterionKey: a", "    unit: COUNT", "    source: { type: json-path, file: array.json, path: '0' }"].join("\n"),
        undefined as unknown as string,
      ],
    ];
    const [[regexCfg, regexReason], [pathCfg, pathReason], [countCfg, countReason]] = cases;
    expect(() => extractMeasurements(loadMeasurementsConfig(write("c1.yml", regexCfg)), dir)).toThrowError(new RegExp(regexReason));
    expect(() => extractMeasurements(loadMeasurementsConfig(write("c2.yml", pathCfg)), dir)).toThrowError(new RegExp(pathReason));
    expect(() => extractMeasurements(loadMeasurementsConfig(write("c3.yml", countCfg)), dir)).toThrowError(new RegExp(countReason));
  });

  it("rejects a regex capture group that does not exist and a non-numeric capture", () => {
    write("has-number.txt", "count=7 of 10");
    const noSuchGroup = loadMeasurementsConfig(
      write(
        "cfg-group.yml",
        ["measurements:", "  - criterionKey: a", "    unit: COUNT", "    source: { type: regex, file: has-number.txt, pattern: 'count=(\\d+)', group: 2 }"].join(
          "\n",
        ),
      ),
    );
    expect(() => extractMeasurements(noSuchGroup, dir)).toThrowError(/has no capture group 2/);

    const notNumeric = loadMeasurementsConfig(
      write(
        "cfg-nan.yml",
        ["measurements:", "  - criterionKey: a", "    unit: COUNT", "    source: { type: regex, file: has-number.txt, pattern: '(count)' }"].join("\n"),
      ),
    );
    expect(() => extractMeasurements(notNumeric, dir)).toThrowError(/is not a number/);
  });

  it("rejects an invalid regex pattern and a malformed JSON file with the file name in the message", () => {
    write("bad.json", "{not json");
    const regexConfig = loadMeasurementsConfig(
      write(
        "cfg-regex.yml",
        ["measurements:", "  - criterionKey: a", "    unit: COUNT", "    source: { type: regex, file: bad.json, pattern: '(unterminated' }"].join("\n"),
      ),
    );
    expect(() => extractMeasurements(regexConfig, dir)).toThrowError(/invalid regex pattern/);

    const jsonConfig = loadMeasurementsConfig(
      write("cfg-json.yml", ["measurements:", "  - criterionKey: b", "    unit: COUNT", "    source: { type: json-path, file: bad.json, path: x }"].join("\n")),
    );
    expect(() => extractMeasurements(jsonConfig, dir)).toThrowError(/bad\.json is not valid JSON/);
  });

  it("resolves the file relative to cwd and also accepts an absolute path", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "value.json"), JSON.stringify({ n: 5 }), "utf8");
    const config = loadMeasurementsConfig(
      write("cfg.yml", ["measurements:", "  - criterionKey: a", "    unit: COUNT", `    source: { type: json-path, file: ${join(sub, "value.json")}, path: n }`].join("\n")),
    );
    expect(extractMeasurements(config, dir).measurements[0].value).toBe(5);
  });
});
