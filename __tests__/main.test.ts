import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { polarisError } from "../src/client";
import { InputError } from "../src/inputs";
import { reportFailure, run } from "../src/main";

type SummaryMock = {
  addHeading: ReturnType<typeof vi.fn>;
  addTable: ReturnType<typeof vi.fn>;
  addRaw: ReturnType<typeof vi.fn>;
  string: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => {
  const summary: SummaryMock = {
    addHeading: vi.fn((): SummaryMock => summary),
    addTable: vi.fn((): SummaryMock => summary),
    addRaw: vi.fn((): SummaryMock => summary),
    string: vi.fn(() => ""),
    write: vi.fn(() => Promise.resolve()),
  };
  return {
    summary,
    stepInputs: {} as Record<string, string>,
    submitMeasurements: vi.fn(),
  };
});

vi.mock("@actions/core", () => ({
  getInput: (name: string) => mocks.stepInputs[name] ?? "",
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  summary: mocks.summary,
}));

vi.mock("../src/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client")>()),
  submitMeasurements: mocks.submitMeasurements,
}));

const EVALUATION = {
  evaluationId: "eval-1",
  outcome: "PASS",
  disposition: "ACCEPTED",
  replayed: false,
  observedAt: "2026-08-22T09:15:00Z",
  validUntil: "2026-08-22T09:20:00Z",
  criterionResults: [{ criterionKey: "latency", outcome: "PASS" }],
};

function stepInputs(overrides: Record<string, string> = {}): void {
  Object.assign(mocks.stepInputs, {
    "polaris-url": "https://polaris.example.com",
    "fitness-function-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c22",
    "producer-id": "01984361-4f3a-7abc-9f0e-2b2a6d5f1c23",
    measurements: '[{"criterionKey":"latency","value":120,"unit":"ms"}]',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.stepInputs)) delete mocks.stepInputs[key];
  vi.stubEnv("POLARIS_INGEST_SECRET_KEY", "secret-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("run", () => {
  it("fails fast when POLARIS_INGEST_SECRET_KEY is not set", async () => {
    vi.stubEnv("POLARIS_INGEST_SECRET_KEY", "");
    stepInputs();
    await expect(run()).rejects.toThrowError(/POLARIS_INGEST_SECRET_KEY is not set/);
    expect(core.setSecret).not.toHaveBeenCalled();
    expect(mocks.submitMeasurements).not.toHaveBeenCalled();
  });

  it("masks the key, submits, sets outputs, and writes the summary on PASS", async () => {
    stepInputs();
    mocks.submitMeasurements.mockResolvedValue(EVALUATION);
    await run();

    expect(core.setSecret).toHaveBeenCalledWith("secret-1");
    expect(mocks.submitMeasurements).toHaveBeenCalledTimes(1);
    const [submittedInputs, apiKey] = mocks.submitMeasurements.mock.calls[0] as [
      { fitnessFunctionId: string },
      string,
    ];
    expect(apiKey).toBe("secret-1");
    expect(submittedInputs.fitnessFunctionId).toBe("01984361-4f3a-7abc-9f0e-2b2a6d5f1c22");

    expect(core.setOutput).toHaveBeenCalledWith("evaluation-id", "eval-1");
    expect(core.setOutput).toHaveBeenCalledWith("outcome", "PASS");
    expect(core.setOutput).toHaveBeenCalledWith("disposition", "ACCEPTED");
    expect(core.setOutput).toHaveBeenCalledWith("replayed", "false");
    expect(mocks.summary.write).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("renders criterion results as a second summary table", async () => {
    stepInputs();
    mocks.submitMeasurements.mockResolvedValue(EVALUATION);
    await run();

    expect(mocks.summary.addTable).toHaveBeenCalledTimes(2);
    expect(mocks.summary.addTable.mock.calls[1][0]).toEqual([
      [
        { data: "Criterion", header: true },
        { data: "Outcome", header: true },
      ],
      ["latency", "PASS"],
    ]);
  });

  it("omits the criterion table when there are no criterion results", async () => {
    stepInputs();
    mocks.submitMeasurements.mockResolvedValue({ ...EVALUATION, criterionResults: [] });
    await run();
    expect(mocks.summary.addTable).toHaveBeenCalledTimes(1);
  });

  it("stringifies a replayed evaluation", async () => {
    stepInputs();
    mocks.submitMeasurements.mockResolvedValue({ ...EVALUATION, replayed: true });
    await run();
    expect(core.setOutput).toHaveBeenCalledWith("replayed", "true");
  });

  it("fails the step on FAIL with the default policy", async () => {
    stepInputs();
    mocks.submitMeasurements.mockResolvedValue({ ...EVALUATION, outcome: "FAIL" });
    await run();
    expect(core.error).toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("outcome FAIL"));
  });

  it("warns without failing on WARN with fail-on=never", async () => {
    stepInputs({ "fail-on": "never" });
    mocks.submitMeasurements.mockResolvedValue({ ...EVALUATION, outcome: "WARN" });
    await run();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("WARN"));
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("fails the step on ERROR regardless of policy", async () => {
    stepInputs({ "fail-on": "never" });
    mocks.submitMeasurements.mockResolvedValue({ ...EVALUATION, outcome: "ERROR" });
    await run();
    expect(core.setFailed).toHaveBeenCalled();
  });

  it("rejects invalid inputs before any network call", async () => {
    stepInputs({ "polaris-url": "" });
    await expect(run()).rejects.toThrowError(InputError);
    expect(mocks.submitMeasurements).not.toHaveBeenCalled();
  });

  it("keeps the fail-on decision when the summary write fails", async () => {
    stepInputs();
    mocks.submitMeasurements.mockResolvedValue({ ...EVALUATION, outcome: "FAIL" });
    mocks.summary.write.mockRejectedValueOnce(new Error("summary unavailable"));
    await run();

    expect(core.setOutput).toHaveBeenCalledWith("outcome", "FAIL");
    expect(core.debug).toHaveBeenCalledWith(expect.stringContaining("summary unavailable"));
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("outcome FAIL"));
  });

  it("warns about each skipped optional measurement discovered via measurements-config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-action-"));
    try {
      const configFile = join(dir, "config.yml");
      writeFileSync(
        configFile,
        [
          "measurements:",
          "  - criterionKey: latency",
          "    unit: ms",
          "    source: { type: json-path, file: " + join(dir, "metrics.json") + ", path: latency }",
          "  - criterionKey: weekly_mutation",
          "    unit: PERCENT",
          "    required: false",
          "    source: { type: json-path, file: " + join(dir, "absent.json") + ", path: efficacy }",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(join(dir, "metrics.json"), JSON.stringify({ latency: 120 }), "utf8");
      stepInputs({ measurements: "", "measurements-config": configFile });
      mocks.submitMeasurements.mockResolvedValue(EVALUATION);
      await run();

      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('skipped optional measurement "weekly_mutation"'));
      const [submittedInputs] = mocks.submitMeasurements.mock.calls[0] as [{ measurements: unknown[] }];
      expect(submittedInputs.measurements).toEqual([{ criterionKey: "latency", value: 120, unit: "ms" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reportFailure", () => {
  it("prefixes input errors", () => {
    reportFailure(new InputError("boom"));
    expect(core.setFailed).toHaveBeenCalledWith("Invalid action inputs: boom");
  });

  it("appends the problem detail of Polaris errors", () => {
    reportFailure(polarisError("Polaris request failed with status 500", { status: 500, detail: "down", retryable: false }));
    expect(core.setFailed).toHaveBeenCalledWith("Polaris request failed with status 500 (down)");
  });

  it("stringifies non-error values", () => {
    reportFailure("just a string");
    expect(core.setFailed).toHaveBeenCalledWith("just a string");
  });

  it("ignores non-string details", () => {
    const error = new Error("weird") as Error & { detail: number };
    error.detail = 42;
    reportFailure(error);
    expect(core.setFailed).toHaveBeenCalledWith("weird");
  });
});
