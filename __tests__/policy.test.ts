import { describe, expect, it } from "vitest";
import { decide } from "../src/policy";
import type { SubmissionResult } from "../src/client";

function result(outcome: string): SubmissionResult {
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

describe("fail-on policy", () => {
  const cases: Array<{ failOn: "never" | "warn" | "fail"; outcome: string; exitCode: 0 | 1; annotation: string }> = [
    { failOn: "never", outcome: "PASS", exitCode: 0, annotation: "none" },
    { failOn: "never", outcome: "WARN", exitCode: 0, annotation: "warning" },
    { failOn: "never", outcome: "FAIL", exitCode: 0, annotation: "error" },
    { failOn: "warn", outcome: "PASS", exitCode: 0, annotation: "none" },
    { failOn: "warn", outcome: "WARN", exitCode: 1, annotation: "warning" },
    { failOn: "warn", outcome: "FAIL", exitCode: 1, annotation: "error" },
    { failOn: "fail", outcome: "PASS", exitCode: 0, annotation: "none" },
    { failOn: "fail", outcome: "WARN", exitCode: 0, annotation: "warning" },
    { failOn: "fail", outcome: "FAIL", exitCode: 1, annotation: "error" },
  ];
  for (const tc of cases) {
    it(`fail-on=${tc.failOn} + ${tc.outcome} -> exit ${tc.exitCode}`, () => {
      const decision = decide(tc.failOn, result(tc.outcome));
      expect(decision.exitCode).toBe(tc.exitCode);
      expect(decision.annotation).toBe(tc.annotation);
    });
  }

  it("always fails on ERROR regardless of policy", () => {
    for (const failOn of ["never", "warn", "fail"] as const) {
      const decision = decide(failOn, result("ERROR"));
      expect(decision.exitCode).toBe(1);
      expect(decision.annotation).toBe("error");
    }
  });

  it("never fails on NOT_APPLICABLE regardless of policy", () => {
    for (const failOn of ["never", "warn", "fail"] as const) {
      expect(decide(failOn, result("NOT_APPLICABLE")).exitCode).toBe(0);
    }
  });

  it("fails closed on unknown outcomes under any policy", () => {
    for (const failOn of ["never", "warn", "fail"] as const) {
      for (const outcome of ["", "SOMETHING_ELSE"]) {
        const decision = decide(failOn, result(outcome));
        expect(decision.exitCode).toBe(1);
        expect(decision.annotation).toBe("error");
        expect(decision.reason).toContain(outcome || "unknown");
      }
    }
  });

  it("explains the trigger in the reason", () => {
    expect(decide("warn", result("WARN")).reason).toBe("outcome WARN with fail-on=warn");
    expect(decide("never", result("FAIL")).reason).toBe("outcome FAIL (fail-on=never)");
    expect(decide("fail", result("PASS")).reason).toBe("outcome PASS");
  });
});
