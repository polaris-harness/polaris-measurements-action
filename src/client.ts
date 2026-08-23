import type { ParsedInputs } from "./inputs";

export type CriterionResult = {
  criterionKey?: string;
  outcome?: string;
  detail?: string;
  [key: string]: unknown;
};

export type SubmissionResult = {
  evaluationId: string;
  outcome: string;
  disposition: string;
  replayed: boolean;
  observedAt: string;
  validUntil: string;
  criterionResults: CriterionResult[];
};

export type PolarisError = Error & {
  status?: number;
  code?: string;
  detail?: string;
  retryable: boolean;
};

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export function polarisError(message: string, options: { status?: number; code?: string; detail?: string; retryable: boolean }): PolarisError {
  const error = new Error(message) as PolarisError;
  error.status = options.status;
  error.code = options.code;
  error.detail = options.detail;
  error.retryable = options.retryable;
  return error;
}

export async function submitMeasurements(
  inputs: ParsedInputs,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmissionResult> {
  const url = submissionURL(inputs.polarisURL, inputs.fitnessFunctionId);
  const body = JSON.stringify({
    fitnessFunctionVersion: inputs.fitnessFunctionVersion,
    producerId: inputs.producerId,
    externalRunId: inputs.externalRunId,
    observedAt: inputs.observedAt,
    measurements: inputs.measurements,
    ...(inputs.evidence.length > 0 ? { evidence: inputs.evidence } : {}),
  });

  let lastError: PolarisError | undefined;
  for (let attempt = 1; attempt <= inputs.maxAttempts; attempt++) {
    try {
      return await postOnce(url, body, apiKey, inputs, fetchImpl);
    } catch (error) {
      const polarisErr = asPolarisError(error);
      if (!polarisErr.retryable || attempt === inputs.maxAttempts) {
        throw polarisErr;
      }
      lastError = polarisErr;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError ?? polarisError("submission failed", { retryable: false });
}

async function postOnce(
  url: string,
  body: string,
  apiKey: string,
  inputs: ParsedInputs,
  fetchImpl: typeof fetch,
): Promise<SubmissionResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Key": apiKey,
        "Idempotency-Key": inputs.externalRunId,
      },
      body,
      signal: AbortSignal.timeout(inputs.timeoutSeconds * 1000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : String(error);
    const timedOut = reason === "TimeoutError" || reason === "AbortError";
    throw polarisError(
      timedOut ? `request timed out after ${inputs.timeoutSeconds}s` : `could not reach Polaris at ${url}: ${reason}`,
      { retryable: true, detail: timedOut ? undefined : String(error) },
    );
  }

  if (response.status === 201) {
    return parseResult(await response.json());
  }

  const problem = await parseProblem(response);
  throw problemFor(response.status, problem);
}

function parseResult(payload: unknown): SubmissionResult {
  const document = payload as Record<string, unknown>;
  if (typeof document.evaluationId !== "string" || typeof document.outcome !== "string") {
    throw polarisError("Polaris returned an unexpected evaluation document", { retryable: false });
  }
  return {
    evaluationId: document.evaluationId,
    outcome: document.outcome,
    disposition: typeof document.disposition === "string" ? document.disposition : "",
    replayed: document.replayed === true,
    observedAt: typeof document.observedAt === "string" ? document.observedAt : "",
    validUntil: typeof document.validUntil === "string" ? document.validUntil : "",
    criterionResults: Array.isArray(document.criterionResults) ? (document.criterionResults as CriterionResult[]) : [],
  };
}

async function parseProblem(response: Response): Promise<{ detail?: string; code?: string; status?: number }> {
  try {
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      detail: typeof payload.detail === "string" ? payload.detail : undefined,
      code: typeof payload.code === "string" ? payload.code : undefined,
      status: typeof payload.status === "number" ? payload.status : response.status,
    };
  } catch {
    return {};
  }
}

function problemFor(status: number, problem: { detail?: string; code?: string; status?: number }): PolarisError {
  const hint = problem.detail ? `: ${problem.detail}` : "";
  switch (status) {
    case 401:
      return polarisError(`Polaris rejected the ingest key (401)${hint}`, { status: 401, code: problem.code, detail: problem.detail, retryable: false });
    case 404:
      return polarisError(`fitness function or producer not found (404)${hint}`, { status: 404, code: problem.code, detail: problem.detail, retryable: false });
    case 409:
      return polarisError(`fitness-function version is not active (409)${hint}`, { status: 409, code: problem.code, detail: problem.detail, retryable: false });
    case 422:
      return polarisError(`measurements rejected (422)${hint}`, { status: 422, code: problem.code, detail: problem.detail, retryable: false });
    default:
      return polarisError(`Polaris request failed with status ${status}${hint}`, {
        status,
        code: problem.code,
        detail: problem.detail,
        retryable: RETRYABLE_STATUS.has(status),
      });
    }
}

export function submissionURL(base: string, fitnessFunctionId: string): string {
  return `${base.replace(/\/+$/, "")}/api/v1/fitness-functions/${encodeURIComponent(fitnessFunctionId)}/measurement-submissions`;
}

function asPolarisError(error: unknown): PolarisError {
  if (isPolarisError(error)) {
    return error;
  }
  return polarisError(error instanceof Error ? error.message : String(error), { retryable: true });
}

function isPolarisError(error: unknown): error is PolarisError {
  return error instanceof Error && "retryable" in error;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
