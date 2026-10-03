import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { submitMeasurements } from "../src/client";
import { parseInputs } from "../src/inputs";

const FUNCTION_ID = "01984361-4f3a-7abc-9f0e-2b2a6d5f1c22";
const API_KEY = "e2e-ingest-secret";

let server: Server;
let baseURL: string;
let sawRequest: { path: string; apiKey: string | undefined; idempotencyKey: string | undefined; body: unknown };
let scriptedFailure: { status: number; detail: string } | undefined;

function header(request: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      sawRequest = {
        path: request.url ?? "",
        apiKey: header(request, "x-api-key"),
        idempotencyKey: header(request, "idempotency-key"),
        body: JSON.parse(raw),
      };
      response.setHeader("Content-Type", "application/json");
      if (sawRequest.apiKey !== API_KEY) {
        response.statusCode = 401;
        response.end(JSON.stringify({ title: "Unauthorized", status: 401, code: "UNAUTHENTICATED", detail: "invalid X-API-Key" }));
        return;
      }
      if (scriptedFailure !== undefined) {
        const { status, detail } = scriptedFailure;
        scriptedFailure = undefined;
        response.statusCode = status;
        response.end(JSON.stringify({ title: "Problem", status, code: "PROBLEM", detail }));
        return;
      }
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          evaluationId: "eval-e2e",
          fitnessFunctionId: FUNCTION_ID,
          fitnessFunctionVersion: 1,
          acquisitionMode: "PUSH",
          outcome: "PASS",
          disposition: "ACCEPTED",
          observedAt: "2026-08-22T09:15:00Z",
          validUntil: "2026-08-22T09:20:00Z",
          criterionResults: [{ criterionKey: "latency", outcome: "PASS" }],
          replayed: false,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  baseURL = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  scriptedFailure = undefined;
});

describe("end-to-end against a local server", () => {
  it("submits measurements and returns the evaluation", async () => {
    const inputs = parseInputs(
      {
        "polaris-url": baseURL,
        "fitness-function-id": FUNCTION_ID,
        "producer-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c23",
        measurements: '[{"criterionKey":"latency","value":95,"unit":"ms"}]',
        "external-run-id": "e2e-run-1",
      },
      {},
    );
    const result = await submitMeasurements(inputs, API_KEY);
    expect(result.evaluationId).toBe("eval-e2e");
    expect(result.outcome).toBe("PASS");
    expect(result.criterionResults[0].criterionKey).toBe("latency");

    expect(sawRequest?.path).toBe(`/api/v1/fitness-functions/${FUNCTION_ID}/measurement-submissions`);
    expect(sawRequest?.apiKey).toBe(API_KEY);
    expect(sawRequest?.idempotencyKey).toBe("e2e-run-1");
    expect(sawRequest?.body).toMatchObject({ producerId: "01984361-4f3a-7abc-9f0e-2b2a6d5f1c23" });
  });

  it("maps a wrong ingest key to an actionable error", async () => {
    const inputs = parseInputs(
      {
        "polaris-url": baseURL,
        "fitness-function-id": FUNCTION_ID,
        "producer-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c23",
        measurements: '[{"criterionKey":"latency","value":95,"unit":"ms"}]',
      },
      {},
    );
    await expect(submitMeasurements(inputs, "wrong-key")).rejects.toThrowError(/ingest key.*invalid X-API-Key/);
  });

  it("retries a transient 503 against a real server", async () => {
    scriptedFailure = { status: 503, detail: "temporarily unavailable" };
    const inputs = parseInputs(
      {
        "polaris-url": baseURL,
        "fitness-function-id": FUNCTION_ID,
        "producer-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c23",
        measurements: '[{"criterionKey":"latency","value":95,"unit":"ms"}]',
        "external-run-id": "e2e-run-retry",
        "max-attempts": "2",
      },
      {},
    );
    const result = await submitMeasurements(inputs, API_KEY);
    expect(result.evaluationId).toBe("eval-e2e");
    expect(sawRequest?.idempotencyKey).toBe("e2e-run-retry");
  });

  it("surfaces problem details from a 422", async () => {
    scriptedFailure = { status: 422, detail: "unit mismatch" };
    const inputs = parseInputs(
      {
        "polaris-url": baseURL,
        "fitness-function-id": FUNCTION_ID,
        "producer-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c23",
        measurements: '[{"criterionKey":"latency","value":95,"unit":"ms"}]',
      },
      {},
    );
    await expect(submitMeasurements(inputs, API_KEY)).rejects.toThrowError(/measurements rejected \(422\): unit mismatch/);
  });
});
