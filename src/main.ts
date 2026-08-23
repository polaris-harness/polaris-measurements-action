import * as core from "@actions/core";
import { parseInputs, InputError } from "./inputs";
import { submitMeasurements } from "./client";
import { decide } from "./policy";

const INPUT_NAMES = [
  "polaris-url",
  "fitness-function-id",
  "producer-id",
  "fitness-function-version",
  "measurements",
  "measurements-file",
  "external-run-id",
  "observed-at",
  "evidence",
  "timeout-seconds",
  "max-attempts",
  "fail-on",
] as const;

function rawInputs(): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const name of INPUT_NAMES) {
    raw[name] = core.getInput(name);
  }
  return raw;
}

async function run(): Promise<void> {
  const apiKey = process.env.POLARIS_INGEST_SECRET_KEY ?? "";
  if (apiKey === "") {
    throw new InputError(
      "POLARIS_INGEST_SECRET_KEY is not set. Add it to the step env from a repository secret (see the action README).",
    );
  }
  core.setSecret(apiKey);

  const inputs = parseInputs(rawInputs(), process.env);
  const result = await submitMeasurements(inputs, apiKey);

  core.setOutput("evaluation-id", result.evaluationId);
  core.setOutput("outcome", result.outcome);
  core.setOutput("disposition", result.disposition);
  core.setOutput("replayed", String(result.replayed));

  await writeSummary(result);

  const decision = decide(inputs.failOn, result);
  if (decision.annotation === "warning") {
    core.warning(decision.reason);
  } else if (decision.annotation === "error") {
    core.error(decision.reason);
  }
  if (decision.exitCode === 1) {
    core.setFailed(`Polaris evaluation failed the step: ${decision.reason}`);
  }
}

/** Best-effort step summary: a summary environment problem must never mask the
 * submission result or the fail-on decision. */
async function writeSummary(result: Awaited<ReturnType<typeof submitMeasurements>>): Promise<void> {
  try {
    const summary = core.summary
      .addHeading("Polaris evaluation")
      .addTable([
        [
          { data: "Field", header: true },
          { data: "Value", header: true },
        ],
        ["Outcome", result.outcome],
        ["Disposition", result.disposition],
        ["Evaluation", result.evaluationId],
        ["Replayed", String(result.replayed)],
        ["Valid until", result.validUntil],
      ]);
    if (result.criterionResults.length > 0) {
      summary
        .addHeading("Criterion results", 3)
        .addTable([
          [
            { data: "Criterion", header: true },
            { data: "Outcome", header: true },
          ],
          ...result.criterionResults.map((criterion) => [
            String(criterion.criterionKey ?? ""),
            String(criterion.outcome ?? ""),
          ]),
        ]);
    }
    await summary.write();
  } catch (error) {
    core.debug(`step summary unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

run().catch((error) => {
  if (error instanceof InputError) {
    core.setFailed(`Invalid action inputs: ${error.message}`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const detail = typeof (error as { detail?: string }).detail === "string" ? ` (${(error as { detail: string }).detail})` : "";
  core.setFailed(`${message}${detail}`);
});
