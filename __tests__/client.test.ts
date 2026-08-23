import { afterEach, describe, expect, it, vi } from "vitest";
import { submissionURL, submitMeasurements, type PolarisError } from "../src/client";
import { parseInputs, type ParsedInputs } from "../src/inputs";

const FUNCTION_ID = "01984361-4f3a-7abc-9f0e-2b2a6d5f1c22";
const API_KEY = "ingest-secret-value";

function inputs(overrides: Record<string, string> = {}): ParsedInputs {
  return parseInputs(
    {
      "polaris-url": "https://polaris.example.com",
      "fitness-function-id": FUNCTION_ID,
      "producer-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c23",
      measurements: '[{"criterionKey":"latency","value":120,"unit":"ms"}]',
      "max-attempts": "2",
      "timeout-seconds": "5",
      ...overrides,
    },
    {},
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": body && (body as { code?: string }).code ? "application/problem+json" : "application/json" },
  });
}

function evaluation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evaluationId: "eval-1",
    outcome: "PASS",
    disposition: "ACCEPTED",
    replayed: false,
    observedAt: "2026-08-22T09:15:00Z",
    validUntil: "2026-08-22T09:20:00Z",
    criterionResults: [{ criterionKey: "latency", outcome: "PASS" }],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("submissionURL", () => {
  it("builds the ingest path and trims trailing slashes", () => {
    expect(submissionURL("https://polaris.example.com/", FUNCTION_ID)).toBe(
      `https://polaris.example.com/api/v1/fitness-functions/${FUNCTION_ID}/measurement-submissions`,
    );
  });
});

describe("submitMeasurements", () => {
  it("sends the ingest key, idempotency key, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, evaluation()));
    const result = await submitMeasurements(inputs(), API_KEY, fetchMock as unknown as typeof fetch);

    expect(result.evaluationId).toBe("eval-1");
    expect(result.replayed).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://polaris.example.com/api/v1/fitness-functions/${FUNCTION_ID}/measurement-submissions`);
    expect(new Headers(init.headers).get("X-API-Key")).toBe(API_KEY);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("github-local-attempt-1");
    const body = JSON.parse(String(init.body));
    expect(body.producerId).toBe("01984361-4f3a-7abc-9f0e-2b2a6d5f1c23");
    expect(body.fitnessFunctionVersion).toBe(1);
    expect(body.measurements).toEqual([{ criterionKey: "latency", value: 120, unit: "ms" }]);
    expect(body.evidence).toBeUndefined();
  });

  it("includes evidence only when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, evaluation()));
    await submitMeasurements(
      inputs({ evidence: '[{"report":"https://ci.example.com/r"}]' }),
      API_KEY,
      fetchMock as unknown as typeof fetch,
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.evidence).toEqual([{ report: "https://ci.example.com/r" }]);
  });

  it("surfaces replayed evaluations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, evaluation({ replayed: true })));
    const result = await submitMeasurements(inputs(), API_KEY, fetchMock as unknown as typeof fetch);
    expect(result.replayed).toBe(true);
  });

  it.each([
    [401, /rejected the ingest key/],
    [404, /not found/],
    [409, /not active/],
    [422, /rejected/],
  ])("maps problem status %d without retrying", async (status, message) => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(status, { title: "x", status, code: "UNAUTHENTICATED", detail: "the detail" }),
    );
    await expect(submitMeasurements(inputs(), API_KEY, fetchMock as unknown as typeof fetch)).rejects.toThrowError(message);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("attaches the problem detail to mapped errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(422, { title: "x", status: 422, detail: "unit mismatch" }));
    const error = (await submitMeasurements(inputs(), API_KEY, fetchMock as unknown as typeof fetch).catch(
      (caught: unknown) => caught,
    )) as PolarisError;
    expect(error.detail).toBe("unit mismatch");
    expect(error.message).toContain("unit mismatch");
  });

  it("retries 503 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { title: "unavailable" }))
      .mockResolvedValueOnce(jsonResponse(201, evaluation()));
    const result = await submitMeasurements(inputs(), API_KEY, fetchMock as unknown as typeof fetch);
    expect(result.evaluationId).toBe("eval-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after max attempts on persistent 503", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { title: "unavailable" }));
    await expect(submitMeasurements(inputs(), API_KEY, fetchMock as unknown as typeof fetch)).rejects.toThrowError(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries network failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(201, evaluation()));
    const result = await submitMeasurements(inputs(), API_KEY, fetchMock as unknown as typeof fetch);
    expect(result.outcome).toBe("PASS");
  });

  it("reports timeouts as retryable errors without leaking the key", async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    await expect(submitMeasurements(inputs(), API_KEY, fetchMock as unknown as typeof fetch)).rejects.toThrowError(/timed out after 5s/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed evaluation documents", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { unexpected: true }));
    await expect(submitMeasurements(inputs(), API_KEY, fetchMock as unknown as typeof fetch)).rejects.toThrowError(/unexpected evaluation document/);
  });
});
