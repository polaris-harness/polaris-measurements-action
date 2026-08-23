import type { FailOn } from "./inputs";
import type { SubmissionResult } from "./client";

export type PolicyDecision = {
  exitCode: 0 | 1;
  annotation: "none" | "warning" | "error";
  reason: string;
};

/**
 * Maps the evaluation outcome to an exit decision.
 *
 * - `never`: the step always succeeds; outcomes are reported as outputs only.
 * - `warn`: WARN and FAIL fail the step.
 * - `fail` (default): FAIL fails the step.
 *
 * ERROR always fails regardless of policy: it means evaluation could not
 * complete, which is an infrastructure problem rather than a fitness verdict.
 * NOT_APPLICABLE never fails (no required measurement was applicable).
 */
export function decide(failOn: FailOn, result: SubmissionResult): PolicyDecision {
  switch (result.outcome) {
    case "PASS":
    case "NOT_APPLICABLE":
      return { exitCode: 0, annotation: "none", reason: `outcome ${result.outcome}` };
    case "WARN":
      if (failOn === "never") {
        return { exitCode: 0, annotation: "warning", reason: "outcome WARN (fail-on=never)" };
      }
      if (failOn === "warn") {
        return { exitCode: 1, annotation: "warning", reason: "outcome WARN with fail-on=warn" };
      }
      return { exitCode: 0, annotation: "warning", reason: "outcome WARN with fail-on=fail" };
    case "FAIL":
      if (failOn === "never") {
        return { exitCode: 0, annotation: "error", reason: "outcome FAIL (fail-on=never)" };
      }
      return { exitCode: 1, annotation: "error", reason: `outcome FAIL with fail-on=${failOn}` };
    case "ERROR":
    default:
      return { exitCode: 1, annotation: "error", reason: `outcome ${result.outcome || "unknown"} (evaluation did not complete)` };
  }
}
