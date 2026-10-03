import * as fs from "node:fs";
import { z } from "zod";
import { measurementSchema, loadMeasurementsConfig, extractMeasurements, ConfigError } from "./extract";

export { measurementSchema };

export const evidenceSchema = z.array(z.record(z.string(), z.unknown()));

const resourceIdSchema = z.string().refine(
  (val) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val) ||
    (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(val) && val.length <= 63),
  { message: "must be a UUID or slug (e.g. checkout-availability)" },
);

export const failOnSchema = z.enum(["never", "warn", "fail"]);

export type FailOn = z.infer<typeof failOnSchema>;

export type ParsedInputs = {
  polarisURL: string;
  fitnessFunctionId: string;
  producerId: string;
  fitnessFunctionVersion: number;
  externalRunId: string;
  observedAt: string;
  measurements: z.infer<typeof measurementSchema>[];
  /** Optional measurements declared in measurements-config whose source
   * file/pattern did not resolve; reported so the workflow log explains
   * why a criterion is absent instead of leaving it a silent no-op. */
  skippedMeasurements: ExtractionFailureInfo[];
  evidence: z.infer<typeof evidenceSchema>;
  timeoutSeconds: number;
  maxAttempts: number;
  failOn: FailOn;
};

export type ExtractionFailureInfo = { criterionKey: string; reason: string };

type RawInputs = Record<string, string>;

export function parseInputs(
  raw: RawInputs,
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): ParsedInputs {
  const get = (name: string): string => raw[name] ?? "";
  const polarisURL = required(get("polaris-url"), "polaris-url");
  new URL(polarisURL);

  const externalRunId = get("external-run-id") !== "" ? get("external-run-id") : defaultRunId(env);
  const { measurements, skipped } = parseMeasurements(get("measurements"), get("measurements-file"), get("measurements-config"), cwd);

  return {
    polarisURL,
    fitnessFunctionId: parseResourceId(required(get("fitness-function-id"), "fitness-function-id"), "fitness-function-id"),
    producerId: parseResourceId(required(get("producer-id"), "producer-id"), "producer-id"),
    fitnessFunctionVersion: positiveInt(get("fitness-function-version") || "1", "fitness-function-version", 1),
    externalRunId: nonEmpty(externalRunId, "external-run-id"),
    observedAt: timestamp(get("observed-at")),
    measurements,
    skippedMeasurements: skipped,
    evidence: parseEvidence(get("evidence")),
    timeoutSeconds: positiveInt(get("timeout-seconds") || "30", "timeout-seconds", 1),
    maxAttempts: positiveInt(get("max-attempts") || "3", "max-attempts", 1),
    failOn: parseFailOn(get("fail-on") || "fail"),
  };
}

function parseFailOn(value: string): FailOn {
  const result = failOnSchema.safeParse(value);
  if (!result.success) {
    throw new InputError("fail-on must be one of never, warn, or fail");
  }
  return result.data;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new InputError(`${name} is required`);
  }
  return value.trim();
}

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") {
    throw new InputError(`${name} must not be empty`);
  }
  return value.trim();
}

function parseResourceId(value: string, name: string): string {
  const result = resourceIdSchema.safeParse(value);
  if (!result.success) {
    throw new InputError(`${name} ${result.error.issues[0]?.message ?? "is invalid"}`);
  }
  return value;
}

function positiveInt(value: string, name: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new InputError(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

function timestamp(value: string): string {
  if (value === "") {
    return new Date().toISOString();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new InputError("observed-at must be an RFC3339 timestamp");
  }
  return new Date(parsed).toISOString();
}

function parseMeasurements(
  inline: string,
  filePath: string,
  configPath: string,
  cwd: string,
): { measurements: z.infer<typeof measurementSchema>[]; skipped: ExtractionFailureInfo[] } {
  const provided = [inline.trim() !== "", filePath.trim() !== "", configPath.trim() !== ""].filter(Boolean).length;
  if (provided !== 1) {
    throw new InputError("exactly one of measurements, measurements-file, or measurements-config must be provided");
  }

  if (configPath.trim() !== "") {
    return parseMeasurementsFromConfig(configPath.trim(), cwd);
  }

  let payload: unknown;
  if (inline.trim() !== "") {
    payload = parseJSON(inline, "measurements");
  } else {
    if (!fs.existsSync(filePath)) {
      throw new InputError(`measurements-file does not exist: ${filePath}`);
    }
    payload = parseJSON(fs.readFileSync(filePath, "utf8"), `measurements-file (${filePath})`);
  }
  return { measurements: validateMeasurements(payload, "measurements"), skipped: [] };
}

function parseMeasurementsFromConfig(
  configPath: string,
  cwd: string,
): { measurements: z.infer<typeof measurementSchema>[]; skipped: ExtractionFailureInfo[] } {
  try {
    const config = loadMeasurementsConfig(configPath);
    const { measurements, skipped } = extractMeasurements(config, cwd);
    return {
      measurements: validateMeasurements(measurements, `measurements-config (${configPath})`),
      skipped: skipped.map((failure) => ({ criterionKey: failure.criterionKey, reason: failure.reason })),
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new InputError(error.message);
    }
    throw error;
  }
}

function validateMeasurements(payload: unknown, label: string): z.infer<typeof measurementSchema>[] {
  const result = z.array(measurementSchema).min(1, "at least one measurement is required").safeParse(payload);
  if (!result.success) {
    throw new InputError(`${label} ${label === "measurements" ? "are" : "is"} invalid: ${formatIssues(result.error.issues)}`);
  }
  const keys = new Set<string>();
  for (const measurement of result.data) {
    if (keys.has(measurement.criterionKey)) {
      throw new InputError(`${label} ${label === "measurements" ? "contain" : "contains"} duplicate criterionKey "${measurement.criterionKey}"`);
    }
    keys.add(measurement.criterionKey);
  }
  return result.data;
}

function parseEvidence(inline: string): z.infer<typeof evidenceSchema> {
  if (inline.trim() === "") {
    return [];
  }
  const result = evidenceSchema.safeParse(parseJSON(inline, "evidence"));
  if (!result.success) {
    throw new InputError(`evidence is invalid: ${formatIssues(result.error.issues)}`);
  }
  return result.data;
}

function parseJSON(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new InputError(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function defaultRunId(env: Record<string, string | undefined>): string {
  const run = env.GITHUB_RUN_ID ?? "local";
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  return `github-${run}-attempt-${attempt}`;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}
