/**
 * The matrix cell collects CI failure evidence for a CI correction at cell
 * time, through the trusted read-only reader, and hands it to the model port
 * outside the digest-bound request. Collection never blocks or refuses the
 * start, never writes state and never touches the reservation.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type MatrixCellPlanV1,
  matrixDigestV1,
} from "../../src/contracts/matrix.ts";
import {
  type GitHubCheckV1,
  type ModelRunReceiptV1,
  type ModelRunRequestV1,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import type { ModelRunOptionsV1 } from "../../src/contracts/ports-model.ts";
import { planMatrixWave, runMatrixCell } from "../../src/host/matrix.ts";
import {
  cellCiEvidenceReader,
  prepareCellCiEvidence,
} from "../../src/host/matrix-cell-ci-evidence.ts";
import { ciCorrectionFinding } from "../../src/repair/ci-rejection.ts";
import {
  CiLogScanner,
  excerptFromLog,
} from "../../src/repair/ci-evidence-excerpt.ts";
import type {
  CiEvidenceReaderV1,
  CiEvidenceReadInputV1,
  CiEvidenceV1,
} from "../../src/repair/ci-evidence-types.ts";
import { OPERATION_MARGIN_MS } from "../../src/repair/loop-bounds.ts";
import { SHA3, T0 } from "../state/helpers.ts";
import {
  ACTUAL,
  DEADLINE,
  freshIssue,
  makeRig,
  PROVIDER,
  type RigV1,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";
import { fixtureBytes } from "../repair/ci-evidence-fixtures.ts";

const SESSION_MS = 240_000;

function receipt(): ModelRunReceiptV1 {
  return {
    invocationId: "codex-ci-evidence-1",
    outcome: "completed",
    actual: {
      evidenceKind: "request-runtime",
      provider: PROVIDER,
      threadId: "thread-ci",
      turnId: "turn-ci",
      terminalOrigin: "runtime",
      observedTerminalStatus: "completed",
      observedModel: "gpt-reserve",
      observedReasoning: "max",
      durationMs: 100,
      outputChars: 500,
    },
    candidate: null,
    error: null,
  };
}

function evidence1009(input: CiEvidenceReadInputV1): CiEvidenceV1 {
  const scanner = new CiLogScanner();
  scanner.pushBytes(fixtureBytes("real-1009.txt"));
  const excerpt = excerptFromLog(scanner.finish(), 16 * 1024);
  return {
    head: input.head,
    base: input.base,
    omittedChecks: 0,
    unavailable: null,
    checks: [{
      name: "validate",
      conclusion: "failure",
      app: "github-actions",
      workflow: {
        name: "Gateway CI",
        path: ".github/workflows/deno-deploy.yml",
      },
      job: { id: 117390030279, name: "validate" },
      failingSteps: [{
        number: 11,
        name: "Complete Bun gates with the prepared binding",
        conclusion: "failure",
      }],
      classification: "candidate",
      classificationReason: "a repository command failed in a run step",
      annotations: [],
      excerpt: excerpt?.text ?? null,
      excerptLines: null,
      hints: [],
      output: null,
      unavailable: null,
      truncatedScan: false,
    }],
  };
}

class FakeReader implements CiEvidenceReaderV1 {
  readonly inputs: CiEvidenceReadInputV1[] = [];
  constructor(
    private readonly answer: (
      input: CiEvidenceReadInputV1,
    ) => Promise<CiEvidenceV1>,
  ) {}
  readCiFailureEvidence(input: CiEvidenceReadInputV1): Promise<CiEvidenceV1> {
    this.inputs.push(input);
    return this.answer(input);
  }
}

interface CallV1 {
  request: ModelRunRequestV1;
  options: ModelRunOptionsV1 | undefined;
  arity: number;
}

/** One planned fresh cell, optionally re-planned as a CI correction. */
async function plannedCell(
  rig: RigV1,
  ci: boolean,
): Promise<MatrixCellPlanV1> {
  const seeded = await rig.store.writeRepair(
    seedSnapshot([freshIssue(645, rig.base)]),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  const report = await planMatrixWave(rig.deps, rig.planOptions());
  const cell = report.plan.cells[0];
  if (!ci) return cell;
  const request: ModelRunRequestV1 = {
    ...cell.request,
    checkoutBase: SHA3,
    reviewFindings: [
      ciCorrectionFinding(rig.base, [{
        name: "validate",
        status: "completed",
        conclusion: "failure",
        head: SHA3,
        startedAt: T0,
        completedAt: T0,
      } as GitHubCheckV1]),
    ],
  };
  return { ...cell, request, requestDigest: await matrixDigestV1(request) };
}

async function runCell(
  rig: RigV1,
  cell: MatrixCellPlanV1,
  reader: CiEvidenceReaderV1 | undefined,
  at?: number,
) {
  const ctx = await rig.claimCell(cell);
  const calls: CallV1[] = [];
  const model = {
    modelId: "gpt-reserve",
    runModel(...args: [ModelRunRequestV1, ModelRunOptionsV1?]) {
      calls.push({ request: args[0], options: args[1], arity: args.length });
      return Promise.resolve(portOk(receipt()));
    },
  };
  if (at !== undefined) rig.clock.advance(at - rig.clock.now());
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    const result = await runMatrixCell(
      {
        ...ctx.deps,
        model,
        ...(reader === undefined ? {} : { ciEvidence: reader }),
      },
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      rig.clock.now(),
    );
    return { result, calls, stdout, stderr };
  } finally {
    console.log = log;
    console.error = error;
  }
}

Deno.test("a CI correction cell hands the fenced evidence to the model and writes nothing", async () => {
  const rig = await makeRig([645], 1);
  try {
    const cell = await plannedCell(rig, true);
    const before = await snapshot(rig);
    const reader = new FakeReader((input) =>
      Promise.resolve(evidence1009(input))
    );
    const { result, calls, stdout, stderr } = await runCell(rig, cell, reader);
    assert.equal(result.status, "completed", result.detail ?? "");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request, cell.request, "the planned request as-is");
    const text = calls[0].options?.untrustedCiEvidence ?? "";
    assert.match(text, /<<<SENTINEL-UNTRUSTED-CI-OUTPUT [0-9a-f]{32}>>>/);
    assert.match(text, /81:9 {2}error {2}Extract this nested ternary/);
    assert.equal(reader.inputs.length, 1);
    assert.equal(reader.inputs[0].head, SHA3);
    assert.equal(reader.inputs[0].base, rig.base);
    assert.ok(reader.inputs[0].deadlineMs > 0);
    assert.ok(reader.inputs[0].deadlineMs <= 60_000);
    assert.ok(reader.inputs[0].prefer?.("validate"));
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, []);
    // No state write: the reservation stays reserved and every row is equal.
    const after = await snapshot(rig);
    assert.deepEqual(after, before);
    assert.equal(after.reservations[0]?.outcome, "reserved");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a failing evidence reader never blocks the cell: one reason line, one stderr line", async () => {
  const rig = await makeRig([645], 1);
  try {
    const cell = await plannedCell(rig, true);
    const reader = new FakeReader(() => Promise.reject(new Error("boom")));
    const { result, calls, stdout, stderr } = await runCell(rig, cell, reader);
    assert.equal(result.status, "completed");
    assert.equal(
      calls[0].options?.untrustedCiEvidence,
      "CI FAILURE EVIDENCE: unavailable (unavailable): the evidence read failed. " +
        "Use the failing check names in the CI finding and reproduce the failure " +
        "with the repository's own commands.",
    );
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, [
      "sentinel ci-evidence: unavailable ubiquity/ai.ubq.fi",
    ]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a missing Actions permission is reported once with the grant the owner must make", async () => {
  const rig = await makeRig([645], 1);
  try {
    const cell = await plannedCell(rig, true);
    const reader = new FakeReader((input) => {
      const evidence = evidence1009(input);
      evidence.checks[0] = {
        ...evidence.checks[0],
        excerpt: null,
        unavailable: "forbidden_actions_read",
      };
      return Promise.resolve(evidence);
    });
    const { result, calls, stderr } = await runCell(rig, cell, reader);
    assert.equal(result.status, "completed");
    assert.match(
      calls[0].options?.untrustedCiEvidence ?? "",
      /log excerpt unavailable \(forbidden_actions_read\)/,
    );
    assert.deepEqual(stderr, [
      "sentinel ci-evidence: forbidden_actions_read ubiquity/ai.ubq.fi " +
      "(grant actions:read to the matrix_cell App token)",
    ]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("without spare time nothing is collected and the cell still starts", async () => {
  const rig = await makeRig([645], 1);
  try {
    const cell = await plannedCell(rig, true);
    const reader = new FakeReader((input) =>
      Promise.resolve(evidence1009(input))
    );
    // The start still fits (session + margin) but leaves under the guard.
    const at = DEADLINE - SESSION_MS - OPERATION_MARGIN_MS - 30_000;
    const { result, calls } = await runCell(rig, cell, reader, at);
    assert.equal(result.status, "completed", result.detail ?? "");
    assert.equal(reader.inputs.length, 0);
    assert.match(
      calls[0].options?.untrustedCiEvidence ?? "",
      /^CI FAILURE EVIDENCE: unavailable \(no_time\)/,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an ordinary implementation cell never calls the reader", async () => {
  const rig = await makeRig([645], 1);
  try {
    const cell = await plannedCell(rig, false);
    const reader = new FakeReader((input) =>
      Promise.resolve(evidence1009(input))
    );
    const { result, calls } = await runCell(rig, cell, reader);
    assert.equal(result.status, "completed");
    assert.equal(reader.inputs.length, 0);
    assert.equal(calls[0].arity, 1, "today's single-argument call");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a hung reader is abandoned at the collection bound", async () => {
  const reader = new FakeReader(() => new Promise<CiEvidenceV1>(() => {}));
  const request = {
    base: "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha,
    checkoutBase: SHA3,
    reviewFindings: [
      ciCorrectionFinding(
        "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha,
        [
          { name: "validate", conclusion: "failure" } as GitHubCheckV1,
        ],
      ),
    ],
  } as unknown as ModelRunRequestV1;
  const started = Date.now();
  const text = await prepareCellCiEvidence({
    reader,
    request,
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
    now: T0,
    bounds: { runDeadline: T0 + 3_600_000, modelCutoff: T0 + 5_400_000 },
    sessionBound: { maxDurationMs: SESSION_MS, maxOutputChars: 1_000 },
    collectionCapMs: 200,
    diagnostic: () => {},
  });
  assert.ok(Date.now() - started < 3_000);
  assert.equal(
    text,
    "CI FAILURE EVIDENCE: unavailable (timeout): the evidence read ran out of " +
      "its bounded time. Use the failing check names in the CI finding and " +
      "reproduce the failure with the repository's own commands.",
  );
});

Deno.test("the cell reader is target-scoped, uses the cell token and records no rate limit", async () => {
  const requests: HttpRequestV1[] = [];
  const recorded: number[] = [];
  const reader = cellCiEvidenceReader({
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
    http: (request) => {
      requests.push(request);
      return Promise.resolve({
        status: 403,
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1792540800",
        }),
        bodyText: JSON.stringify({ message: "API rate limit exceeded" }),
      });
    },
    clock: { now: () => T0 },
    token: "cell-read-token",
    gate: {
      beforeRequest: () => Promise.resolve(portOk(undefined)),
      // The production cell gate refuses every record.
      recordRateLimit: () => {
        recorded.push(1);
        return Promise.resolve(
          portError("rate_limited", "matrix cell source read was rate limited"),
        );
      },
    },
  });
  const evidence = await reader.readCiFailureEvidence({
    head: SHA3,
    base: SHA3,
    deadlineMs: 5_000,
  });
  assert.equal(evidence.unavailable, "rate_limited");
  assert.equal(recorded.length, 0, "a cell records nothing");
  assert.equal(requests.length, 1, "nothing more is asked after a limit");
  assert.equal(
    new URL(requests[0].url).pathname,
    `/repos/ubiquity/ai.ubq.fi/commits/${SHA3}/check-runs`,
  );
  assert.equal(
    requests[0].headers.get("authorization"),
    "Bearer cell-read-token",
  );
});
