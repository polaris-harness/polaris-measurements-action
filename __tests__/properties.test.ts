import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { submissionURL } from "../src/client";
import { defaultRunId, parseInputs } from "../src/inputs";
import { decide } from "../src/policy";
import type { SubmissionResult } from "../src/client";

function baseRaw(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "polaris-url": "https://polaris.example.com",
    "fitness-function-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c22",
    "producer-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c23",
    measurements: '[{"criterionKey":"latency","value":120,"unit":"ms"}]',
    ...overrides,
  };
}

function evalResult(outcome: string): SubmissionResult {
  return {
    evaluationId: "eval-1",
    outcome,
    disposition: "ACCEPTED",
    replayed: false,
    observedAt: "2026-08-22T09:15:00Z",
    validUntil: "2026-08-22T09:20:00Z",
    criterionResults: [],
  };
}

const measurementArb = fc.record({
  criterionKey: fc.string({ minLength: 1, maxLength: 16 }),
  value: fc.oneof(
    fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
    fc.double({ min: -1e6, max: 1e6, noNaN: true }).filter((v) => !Object.is(v, -0)),
  ),
  unit: fc.string({ minLength: 1, maxLength: 50 }),
  observedAt: fc.option(fc.constant("2026-08-22T09:15:00Z"), { nil: undefined }),
});

describe("submissionURL properties", () => {
  it("builds the documented path for any uuid id", () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        expect(submissionURL("https://polaris.example.com/", id)).toBe(
          `https://polaris.example.com/api/v1/fitness-functions/${id}/measurement-submissions`,
        );
      }),
    );
  });

  it("ignores any number of trailing slashes in the base URL", () => {
    fc.assert(
      fc.property(fc.nat(5), fc.webUrl({ withQueryParameters: false, withFragments: false }), (slashes, base) => {
        expect(submissionURL(base + "/".repeat(slashes), "ff-id")).toBe(submissionURL(base, "ff-id"));
      }),
    );
  });

  it("round-trips any fitness-function id through URL encoding", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (id) => {
        const url = new URL(submissionURL("https://polaris.example.com", id));
        expect(decodeURIComponent(url.pathname.split("/")[4])).toBe(id);
      }),
    );
  });
});

describe("parseInputs properties", () => {
  it("normalizes any parseable observed-at to its UTC ISO instant", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(Date.UTC(1990, 0, 1)), max: new Date(Date.UTC(2100, 0, 1)) }),
        (date) => {
          const iso = date.toISOString();
          expect(parseInputs(baseRaw({ "observed-at": iso }), {}).observedAt).toBe(iso);
        },
      ),
    );
  });

  it("keeps any non-blank external-run-id, trimmed", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim() !== ""),
        (externalRunId) => {
          expect(parseInputs(baseRaw({ "external-run-id": externalRunId }), {}).externalRunId).toBe(externalRunId.trim());
        },
      ),
    );
  });

  it("derives the run id from the environment with stable defaults", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
        fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
        (run, attempt) => {
          expect(defaultRunId({ GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt })).toBe(
            `github-${run ?? "local"}-attempt-${attempt ?? "1"}`,
          );
        },
      ),
    );
  });

  it("round-trips any valid measurement array with unique criterion keys", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(measurementArb, { selector: (m) => m.criterionKey, minLength: 1, maxLength: 8 }),
        (measurements) => {
          expect(parseInputs(baseRaw({ measurements: JSON.stringify(measurements) }), {}).measurements).toEqual(measurements);
        },
      ),
    );
  });

  it("rejects any measurement array with a duplicated criterion key", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(measurementArb, { selector: (m) => m.criterionKey, minLength: 2, maxLength: 8 }),
        (measurements) => {
          const withDuplicate = [...measurements, measurements[0]];
          expect(() => parseInputs(baseRaw({ measurements: JSON.stringify(withDuplicate) }), {})).toThrowError(
            /duplicate criterionKey/,
          );
        },
      ),
    );
  });

  it("rejects any unparseable measurements payload as an input error", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => {
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        }),
        (payload) => {
          expect(() => parseInputs(baseRaw({ measurements: payload }), {})).toThrowError(/not valid JSON/);
        },
      ),
    );
  });
});

describe("policy properties", () => {
  it("fails closed for any unknown outcome under any policy", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 24 }).filter(
          (s) => !["PASS", "WARN", "FAIL", "ERROR", "NOT_APPLICABLE"].includes(s),
        ),
        fc.constantFrom("never", "warn", "fail"),
        (outcome, failOn) => {
          expect(decide(failOn, evalResult(outcome)).exitCode).toBe(1);
        },
      ),
    );
  });

  it("never gets stricter as the policy loosens", () => {
    fc.assert(
      fc.property(fc.constantFrom("PASS", "WARN", "FAIL", "ERROR", "NOT_APPLICABLE"), (outcome) => {
        const result = evalResult(outcome);
        expect(decide("never", result).exitCode).toBeLessThanOrEqual(decide("fail", result).exitCode);
        expect(decide("fail", result).exitCode).toBeLessThanOrEqual(decide("warn", result).exitCode);
      }),
    );
  });
});
