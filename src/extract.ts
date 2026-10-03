import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYAML } from "yaml";
import { z } from "zod";

export const measurementSchema = z.object({
  criterionKey: z.string().min(1, "criterionKey must not be empty"),
  value: z.number().refine((v) => Number.isFinite(v), "value must be finite"),
  unit: z.string().min(1, "unit must not be empty").max(50, "unit must be at most 50 characters"),
  observedAt: z.string().optional(),
});

/**
 * Format-based measurement discovery.
 *
 * The action does not know anything about Go, golangci-lint, govulncheck,
 * gremlins, Trivy, or any other tool. It only knows four generic *shapes* a
 * number can arrive in: a regex capture in a text log, a JSON Pointer-ish
 * path into a JSON document, the length of a JSON array, or a severity-based
 * count of SARIF results. Every current and future CI tool's output reduces
 * to one of those four, so a new tool never requires a code change here —
 * only a new entry in the repo's own `measurements-config` file.
 */

const regexSourceSchema = z.object({
  type: z.literal("regex"),
  file: z.string().min(1),
  pattern: z.string().min(1),
  group: z.number().int().min(0).default(1),
  flags: z.string().default(""),
});

const jsonPathSourceSchema = z.object({
  type: z.literal("json-path"),
  file: z.string().min(1),
  path: z.string().min(1),
});

const jsonCountSourceSchema = z.object({
  type: z.literal("json-count"),
  file: z.string().min(1),
  path: z.string().default("$"),
});

const sarifCountSourceSchema = z.object({
  type: z.literal("sarif-count"),
  file: z.string().min(1),
  minLevel: z.enum(["note", "warning", "error"]).default("warning"),
  ruleIds: z.array(z.string()).optional(),
});

const sourceSchema = z.discriminatedUnion("type", [
  regexSourceSchema,
  jsonPathSourceSchema,
  jsonCountSourceSchema,
  sarifCountSourceSchema,
]);

export type Source = z.infer<typeof sourceSchema>;

const measurementSpecSchema = z.object({
  criterionKey: z.string().min(1),
  unit: z.string().min(1).max(50),
  required: z.boolean().default(true),
  observedAt: z.string().optional(),
  source: sourceSchema,
});

export type MeasurementSpec = z.infer<typeof measurementSpecSchema>;

const configSchema = z.object({
  measurements: z.array(measurementSpecSchema).min(1, "measurements-config must declare at least one measurement"),
});

export type MeasurementsConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** One criterion's discovery outcome, successful or not, kept together so
 * callers can report every problem in a config at once instead of the
 * usual fail-fast-on-the-first-missing-file experience. */
export type ExtractionFailure = { criterionKey: string; required: boolean; reason: string };

export function loadMeasurementsConfig(configPath: string): MeasurementsConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`measurements-config does not exist: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYAML(raw);
  } catch (error) {
    throw new ConfigError(`measurements-config (${configPath}) is not valid YAML/JSON: ${message(error)}`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`measurements-config (${configPath}) is invalid: ${formatIssues(result.error.issues)}`);
  }
  const keys = new Set<string>();
  for (const spec of result.data.measurements) {
    if (keys.has(spec.criterionKey)) {
      throw new ConfigError(`measurements-config (${configPath}) declares duplicate criterionKey "${spec.criterionKey}"`);
    }
    keys.add(spec.criterionKey);
  }
  return result.data;
}

/**
 * Resolves every declared measurement against files on disk (relative to
 * `cwd`, normally the job workspace that an earlier `download-artifact`
 * step already populated). Required measurements that cannot be resolved
 * are collected into a single aggregate error so a workflow author sees
 * every missing artifact in one failure, not one-at-a-time over repeated
 * pushes. Optional measurements that fail are dropped silently from the
 * result (e.g. a mutation report that only exists on the weekly run).
 */
export function extractMeasurements(
  config: MeasurementsConfig,
  cwd: string,
): { measurements: z.infer<typeof measurementSchema>[]; skipped: ExtractionFailure[] } {
  const measurements: z.infer<typeof measurementSchema>[] = [];
  const failures: ExtractionFailure[] = [];
  const skipped: ExtractionFailure[] = [];

  for (const spec of config.measurements) {
    try {
      const value = resolveSource(spec.source, cwd);
      measurements.push(
        measurementSchema.parse({
          criterionKey: spec.criterionKey,
          value,
          unit: spec.unit,
          ...(spec.observedAt ? { observedAt: spec.observedAt } : {}),
        }),
      );
    } catch (error) {
      const failure: ExtractionFailure = { criterionKey: spec.criterionKey, required: spec.required, reason: message(error) };
      if (spec.required) {
        failures.push(failure);
      } else {
        skipped.push(failure);
      }
    }
  }

  if (failures.length > 0) {
    throw new ConfigError(
      `could not discover ${failures.length} required measurement(s): ` +
        failures.map((failure) => `${failure.criterionKey} (${failure.reason})`).join("; "),
    );
  }

  return { measurements, skipped };
}

function resolveSource(source: Source, cwd: string): number {
  const filePath = path.isAbsolute(source.file) ? source.file : path.join(cwd, source.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${source.file}`);
  }

  switch (source.type) {
    case "regex":
      return extractRegex(fs.readFileSync(filePath, "utf8"), source);
    case "json-path":
      return extractJSONPath(readJSON(filePath, source.file), source.path);
    case "json-count":
      return extractJSONCount(readJSON(filePath, source.file), source.path);
    case "sarif-count":
      return extractSARIFCount(readJSON(filePath, source.file), source);
  }
}

function extractRegex(content: string, source: z.infer<typeof regexSourceSchema>): number {
  let regex: RegExp;
  try {
    regex = new RegExp(source.pattern, source.flags);
  } catch (error) {
    throw new Error(`invalid regex pattern "${source.pattern}": ${message(error)}`, { cause: error });
  }
  const match = regex.exec(content);
  if (match === null) {
    throw new Error(`pattern /${source.pattern}/ did not match ${source.file}`);
  }
  const captured = match[source.group];
  if (captured === undefined) {
    throw new Error(`pattern /${source.pattern}/ has no capture group ${source.group}`);
  }
  const value = Number(captured);
  if (!Number.isFinite(value)) {
    throw new Error(`captured text "${captured}" from ${source.file} is not a number`);
  }
  return value;
}

function extractJSONPath(document: unknown, pathExpr: string): number {
  const resolved = resolvePath(document, pathExpr);
  const value = Number(resolved);
  if (resolved === undefined || resolved === null || !Number.isFinite(value)) {
    throw new Error(`path "${pathExpr}" did not resolve to a number (got ${JSON.stringify(resolved)})`);
  }
  return value;
}

function extractJSONCount(document: unknown, pathExpr: string): number {
  const resolved = resolvePath(document, pathExpr);
  if (!Array.isArray(resolved)) {
    throw new Error(`path "${pathExpr}" did not resolve to an array (got ${typeof resolved})`);
  }
  return resolved.length;
}

const SARIF_LEVEL_RANK: Record<string, number> = { note: 0, warning: 1, error: 2 };

function extractSARIFCount(document: unknown, source: z.infer<typeof sarifCountSourceSchema>): number {
  const runs = (document as { runs?: unknown })?.runs;
  if (!Array.isArray(runs)) {
    throw new Error(`${source.file} does not look like a SARIF document (missing "runs")`);
  }
  const minRank = SARIF_LEVEL_RANK[source.minLevel];
  let count = 0;
  for (const run of runs) {
    const results = (run as { results?: unknown })?.results;
    if (!Array.isArray(results)) {
      continue;
    }
    for (const result of results) {
      const level = typeof (result as { level?: unknown }).level === "string" ? (result as { level: string }).level : "warning";
      const rank = SARIF_LEVEL_RANK[level] ?? SARIF_LEVEL_RANK.warning;
      if (rank < minRank) {
        continue;
      }
      const ruleId = (result as { ruleId?: unknown }).ruleId;
      if (source.ruleIds && source.ruleIds.length > 0 && !source.ruleIds.includes(String(ruleId))) {
        continue;
      }
      count++;
    }
  }
  return count;
}

/** Minimal dot/bracket path resolver: `$.a.b[0].c`, `a.b.0.c`, and `$[0]` are
 * all accepted; the leading `$` and `.` are optional. No wildcards, no
 * filters — those belong in regex/json-count, not here. */
export function resolvePath(root: unknown, pathExpr: string): unknown {
  const normalized = pathExpr.trim().replace(/^\$\.?/, "");
  if (normalized === "") {
    return root;
  }
  const segments = normalized.match(/[^.[\]]+/g) ?? [];
  let current: unknown = root;
  for (const segment of segments) {
    if (current === undefined || current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readJSON(filePath: string, label: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${message(error)}`, { cause: error });
  }
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
