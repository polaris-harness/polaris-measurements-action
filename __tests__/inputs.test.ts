import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRunId, parseInputs, InputError, type ParsedInputs } from "../src/inputs";

const baseEnv = { GITHUB_RUN_ID: "417", GITHUB_RUN_ATTEMPT: "1" };

function baseRaw(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "polaris-url": "https://polaris.example.com",
    "fitness-function-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c22",
    "producer-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c23",
    measurements: '[{"criterionKey":"latency","value":120,"unit":"ms"}]',
    ...overrides,
  };
}

function parse(raw: Record<string, string>, env: Record<string, string | undefined> = baseEnv): ParsedInputs {
  return parseInputs(raw, env);
}

describe("input parsing", () => {
  it("applies defaults for optional inputs", () => {
    const inputs = parse(baseRaw());
    expect(inputs.fitnessFunctionVersion).toBe(1);
    expect(inputs.externalRunId).toBe("github-417-attempt-1");
    expect(inputs.timeoutSeconds).toBe(30);
    expect(inputs.maxAttempts).toBe(3);
    expect(inputs.failOn).toBe("fail");
    expect(inputs.evidence).toEqual([]);
    expect(inputs.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps an explicit external-run-id and normalizes observed-at to UTC ISO", () => {
    const inputs = parse(baseRaw({ "external-run-id": "custom-run", "observed-at": "2026-08-22T09:15:00Z" }));
    expect(inputs.externalRunId).toBe("custom-run");
    expect(inputs.observedAt).toBe("2026-08-22T09:15:00.000Z");
  });

  it("reads measurements from a file when inline is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-action-"));
    const file = join(dir, "measurements.json");
    writeFileSync(file, '[{"criterionKey":"error_rate","value":0.8,"unit":"PERCENT"}]', "utf8");
    try {
      const inputs = parse(baseRaw({ measurements: "", "measurements-file": file }));
      expect(inputs.measurements).toHaveLength(1);
      expect(inputs.measurements[0].criterionKey).toBe("error_rate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects both or neither measurement source", () => {
    const both = baseRaw({ "measurements-file": "/tmp/x.json" });
    expect(() => parse(both)).toThrowError(InputError);
    const neither = baseRaw({ measurements: "" });
    expect(() => parse(neither)).toThrowError(/exactly one/i);
  });

  it("rejects missing files, malformed JSON, and empty arrays", () => {
    expect(() => parse(baseRaw({ measurements: "", "measurements-file": "/nonexistent/path.json" }))).toThrowError(/does not exist/i);
    expect(() => parse(baseRaw({ measurements: "{not json" }))).toThrowError(/not valid JSON/i);
    expect(() => parse(baseRaw({ measurements: "[]" }))).toThrowError(/at least one/i);
  });

  it("rejects non-finite values and duplicate criterion keys", () => {
    expect(() => parse(baseRaw({ measurements: '[{"criterionKey":"a","value":NaN,"unit":"ms"}]' }))).toThrowError(/not valid JSON/i);
    const duplicate = JSON.stringify([
      { criterionKey: "latency", value: 1, unit: "ms" },
      { criterionKey: "latency", value: 2, unit: "ms" },
    ]);
    expect(() => parse(baseRaw({ measurements: duplicate }))).toThrowError(/duplicate criterionKey/i);
  });

  it("rejects invalid UUIDs, URLs, integers, and fail-on values", () => {
    expect(() => parse(baseRaw({ "fitness-function-id": "not-a-uuid" }))).toThrowError(/UUID/i);
    expect(() => parse(baseRaw({ "producer-id": "not-a-uuid" }))).toThrowError(/UUID/i);
    expect(() => parse(baseRaw({ "polaris-url": "not a url" }))).toThrowError(/Invalid URL/i);
    expect(() => parse(baseRaw({ "timeout-seconds": "0" }))).toThrowError(/integer/i);
    expect(() => parse(baseRaw({ "max-attempts": "abc" }))).toThrowError(/integer/i);
    expect(() => parse(baseRaw({ "fail-on": "sometimes" }))).toThrowError(/fail-on/i);
    expect(() => parse(baseRaw({ "polaris-url": "" }))).toThrowError(/required/i);
  });

  it("parses evidence documents", () => {
    const inputs = parse(baseRaw({ evidence: '[{"report":"https://ci.example.com/report"}]' }));
    expect(inputs.evidence).toEqual([{ report: "https://ci.example.com/report" }]);
    expect(() => parse(baseRaw({ evidence: '"not-an-array"' }))).toThrowError(/evidence/i);
  });

  it("derives a stable default run id from the environment", () => {
    expect(defaultRunId(baseEnv)).toBe("github-417-attempt-1");
    expect(defaultRunId({})).toBe("github-local-attempt-1");
  });

  it("trims polaris-url and rejects whitespace-only external-run-id", () => {
    const inputs = parse(baseRaw({ "polaris-url": "  https://polaris.example.com  " }));
    expect(inputs.polarisURL).toBe("https://polaris.example.com");
    expect(() => parse(baseRaw({ "external-run-id": "   " }))).toThrowError(/external-run-id must not be empty/i);
  });

  it("keeps an explicit fitness-function-version and enforces its bounds", () => {
    expect(parse(baseRaw({ "fitness-function-version": "7" })).fitnessFunctionVersion).toBe(7);
    expect(() => parse(baseRaw({ "fitness-function-version": "0" }))).toThrowError(/integer >= 1/);
    expect(() => parse(baseRaw({ "fitness-function-version": "1.5" }))).toThrowError(/integer >= 1/);
  });

  it("rejects unparseable observed-at values", () => {
    expect(() => parse(baseRaw({ "observed-at": "definitely-not-a-timestamp" }))).toThrowError(/RFC3339/);
  });

  it("preserves per-measurement observedAt", () => {
    const inputs = parse(baseRaw({ measurements: '[{"criterionKey":"latency","value":1,"unit":"ms","observedAt":"2026-08-22T09:15:00Z"}]' }));
    expect(inputs.measurements[0].observedAt).toBe("2026-08-22T09:15:00Z");
  });

  it("reports the file path when measurements-file content is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-action-"));
    try {
      const badJson = join(dir, "bad.json");
      writeFileSync(badJson, "{nope", "utf8");
      let message = "";
      try {
        parse(baseRaw({ measurements: "", "measurements-file": badJson }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(badJson);
      expect(message).toMatch(/not valid JSON/);

      const badShape = join(dir, "shape.json");
      writeFileSync(badShape, '{"criterionKey":"a"}', "utf8");
      expect(() => parse(baseRaw({ measurements: "", "measurements-file": badShape }))).toThrowError(/measurements are invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates schema issues to the first three", () => {
    let message = "";
    try {
      parse(baseRaw({ measurements: JSON.stringify([{}, {}, {}, {}, {}]) }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/measurements are invalid/);
    expect(message.split("; ")).toHaveLength(3);
  });
});
