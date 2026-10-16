/**
 * A matrix cell whose model run the gateway throttled (HTTP 429 after the
 * port's failover and bounded backoff) settles as transient provider
 * throttling through the real cell, ingester and launcher retry consumers,
 * and everything it writes still parses with the generation-76 parsers.
 */
import assert from "node:assert/strict";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  type ModelRunReceiptV1,
  portError,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  PROVIDER,
  type RigV1,
  ROOT,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

const GENERATION_76 = "41bb853a1bedfc0422bf903dfabbe23bf714b44f";
const THROTTLED_DETAIL = "model run failed (unavailable)";

/** The live failed receipt after Codex's own retries ended on a 429. */
function throttledReceipt(observedModel: string): ModelRunReceiptV1 {
  return {
    invocationId: "codex-throttled-1",
    outcome: "failed",
    actual: {
      evidenceKind: "request-runtime",
      provider: PROVIDER,
      threadId: "thread-throttled",
      turnId: "turn-throttled",
      terminalOrigin: "runtime",
      observedTerminalStatus: "failed",
      observedModel,
      observedReasoning: "max",
      durationMs: 450,
      outputChars: 9_455,
    },
    candidate: null,
    error: "exceeded retry limit, last status: 429 Too Many Requests",
  };
}

function modelReturning(result: PortResultV1<ModelRunReceiptV1>) {
  let calls = 0;
  return {
    port: {
      modelId: "gpt-reserve",
      runModel: () => {
        calls++;
        return Promise.resolve(result);
      },
    },
    calls: () => calls,
  };
}

/** One planned, claimed, executed and ingested cell with `model`. */
async function wave(
  rig: RigV1,
  model: { modelId: string; runModel: () => Promise<unknown> },
) {
  const planned = await planMatrixWave(rig.deps, rig.planOptions());
  assert.equal(planned.prepared, 1, JSON.stringify(planned));
  const cell = planned.plan.cells[0];
  const ctx = await rig.claimCell(cell);
  // deno-lint-ignore no-explicit-any
  (ctx.deps as any).model = model;
  const result = await runMatrixCell(
    ctx.deps,
    { waveId: WAVE, run: RUN, cell },
    ACTUAL,
    rig.clock.now(),
  );
  await rig.transfer([result], [ctx]);
  const report = await ingestMatrixResults(
    rig.deps,
    planned.plan,
    [result],
    rig.ingestOptions(),
  );
  return { cell, result, report };
}

async function readmit(rig: RigV1, runtimeSha: GitSha): Promise<number> {
  const before = await rig.store.readRepair();
  assert.ok(before.ok && before.value.status === "found");
  const now = rig.clock.now();
  const plans = planHostedRetries(before.value.snapshot, now, runtimeSha);
  if (plans.length === 0) return 0;
  const retried = await rig.store.writeRepair(
    applyHostedRetries(before.value.snapshot, before.value.head, plans, now),
    before.value.head,
  );
  assert.ok(retried.ok && retried.value.status === "applied");
  return plans.length;
}

function assertThrottledSettlement(
  result: MatrixCellResultV1,
  state: RepairStateSnapshotV1,
) {
  assert.equal(result.status, "failed");
  assert.equal(result.detail, THROTTLED_DETAIL);
  assert.equal(result.receipt, null, "no raw provider text leaves the cell");
  assert.equal(result.bundle, null);
  const work = state.work[0];
  assert.equal(work.nextStep, "blocked");
  assert.equal(work.blocker?.message, THROTTLED_DETAIL);
  assert.ok(
    state.reservations.every((row) => row.outcome === "ambiguous"),
    "every throttled admission stays charged and is never refunded",
  );
  const entries = state.attemptMemory.flatMap((memory) => memory.entries);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.detail, THROTTLED_DETAIL);
    assert.equal(entry.stage, "model");
    assert.equal(entry.failureClass, "transient_infrastructure");
  }
}

Deno.test(
  "matrix 429: a throttled failover receipt is transient throttling, not a rejected receipt",
  async () => {
    const rig = await makeRig([990429], 1);
    try {
      const issue = freshIssue(990429, rig.base);
      const seeded = await rig.store.writeRepair(seedSnapshot([issue]), null);
      assert.ok(seeded.ok && seeded.value.status === "applied");
      // The port's final attempt was the failover model: the planned request
      // names the primary, so an exported receipt could never verify.
      const model = modelReturning(portOk(throttledReceipt("gpt-6-luna")));
      const { cell, result, report } = await wave(rig, model.port);
      assert.equal(model.calls(), 1, "exactly one model session");
      assert.equal(report.ingested, 1, JSON.stringify(report.entries));
      assert.equal(report.entries[0].disposition, "ingested");
      assertThrottledSettlement(result, await snapshot(rig));
      assert.equal(
        await readmit(rig, cell.runtimeSha as GitSha),
        1,
        "the launcher re-admits the transient throttling blocker",
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "matrix 429: repeated throttling decays as transient instead of a no-progress refusal",
  async () => {
    const rig = await makeRig([990430], 1);
    try {
      const issue = freshIssue(990430, rig.base);
      const seeded = await rig.store.writeRepair(seedSnapshot([issue]), null);
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const runtimeSha = ACTUAL.runtimeSha as GitSha;
      for (let index = 0; index < 3; index++) {
        const model = modelReturning(portOk(throttledReceipt("gpt-reserve")));
        const { result, report } = await wave(rig, model.port);
        assert.equal(report.ingested, 1, JSON.stringify(report.entries));
        assertThrottledSettlement(result, await snapshot(rig));
        assert.equal(
          await readmit(rig, runtimeSha),
          1,
          `throttled outcome ${index + 1} at one base/revision is re-admitted`,
        );
      }
      const state = await snapshot(rig);
      const entry = state.attemptMemory[0].entries[0];
      assert.equal(entry.count, 3, "one equivalent transient fingerprint");
      assert.equal(state.reservations.length, 3, "one charge per admission");
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "matrix 429: an ordinary failed receipt keeps its unchanged no-progress settlement",
  async () => {
    const rig = await makeRig([990431], 1);
    try {
      const issue = freshIssue(990431, rig.base);
      const seeded = await rig.store.writeRepair(seedSnapshot([issue]), null);
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const receipt = { ...throttledReceipt("gpt-reserve"), error: "boom" };
      const { result, report } = await wave(
        rig,
        modelReturning(portOk(receipt)).port,
      );
      assert.equal(result.status, "completed");
      assert.equal(result.receipt?.error, "runtime_error");
      assert.equal(report.ingested, 1, JSON.stringify(report.entries));
      const state = await snapshot(rig);
      assert.equal(
        state.work[0].blocker?.message,
        "model run did not complete with a trusted candidate",
      );
      assert.equal(
        state.attemptMemory[0].entries[0].failureClass,
        "semantic_no_progress",
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "matrix 429: the throttled settlement writes exactly what a port-unavailable cell writes",
  async () => {
    const settle = async (
      model: { modelId: string; runModel: () => Promise<unknown> },
    ) => {
      const rig = await makeRig([990432], 1);
      try {
        const issue = freshIssue(990432, rig.base);
        const seeded = await rig.store.writeRepair(
          seedSnapshot([issue]),
          null,
        );
        assert.ok(seeded.ok && seeded.value.status === "applied");
        const { result } = await wave(rig, model);
        const state = await snapshot(rig);
        const work = state.work[0];
        // Rig-specific identities (base commit, reservation id) differ per
        // rig; every key set, enum value and settled outcome must not.
        const intent = work.intent;
        return {
          result: { status: result.status, detail: result.detail },
          blocker: { ...work.blocker, since: 0 },
          nextStep: work.nextStep,
          workKeys: Object.keys(work).sort(),
          intent: intent === null ? null : {
            keys: Object.keys(intent).sort(),
            kind: intent.kind,
          },
          reservations: state.reservations.map((row) => ({
            keys: Object.keys(row).sort(),
            outcome: row.outcome,
            purpose: row.purpose,
          })),
          entries: state.attemptMemory.flatMap((memory) =>
            memory.entries.map((entry) => ({
              keys: Object.keys(entry).sort(),
              stage: entry.stage,
              failureClass: entry.failureClass,
              detail: entry.detail,
              count: entry.count,
            }))
          ),
        };
      } finally {
        await rig.cleanup();
      }
    };
    // The existing generation-76 producer: the port returned no receipt.
    const unavailable = await settle(
      modelReturning(portError("unavailable", "inert unavailable port")).port,
    );
    const throttled = await settle(
      modelReturning(portOk(throttledReceipt("gpt-6-luna"))).port,
    );
    assert.equal(
      canonicalStringify(throttled),
      canonicalStringify(unavailable),
      "no new record shape, key or enum value",
    );
  },
);

function generation76Present(): boolean {
  try {
    return new Deno.Command("git", {
      args: ["cat-file", "-e", `${GENERATION_76}^{commit}`],
      cwd: ROOT,
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

async function git(args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(output.success, new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout);
}

/** The exact generation-76 contracts, materialized beside the repository. */
async function generation76Contracts(dir: string) {
  const files = (await git([
    "ls-tree",
    "-r",
    "--name-only",
    GENERATION_76,
    "src/contracts",
  ])).split("\n").filter((line) => line.length > 0);
  assert.ok(files.includes("src/contracts/state-snapshots.ts"));
  for (const file of files) {
    const target = `${dir}/${file}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(
      target,
      await git(["show", `${GENERATION_76}:${file}`]),
    );
  }
  const url = (file: string) => new URL(`file://${dir}/src/contracts/${file}`);
  const snapshots = await import(url("state-snapshots.ts").href);
  const matrix = await import(url("matrix.ts").href);
  return {
    parseState: snapshots.parseRepairStateSnapshotV1 as (v: unknown) => unknown,
    parseCell: matrix.parseMatrixCellResultV1 as (v: unknown) => unknown,
  };
}

Deno.test({
  name:
    "matrix 429: generation-76 parsers accept every record the throttled path writes",
  ignore: !generation76Present(),
  fn: async () => {
    const dir = await Deno.makeTempDir({
      dir: ROOT,
      prefix: "sentinel-gen76-contracts-",
    });
    const rig = await makeRig([990433], 1);
    try {
      const gen76 = await generation76Contracts(dir);
      const issue = freshIssue(990433, rig.base);
      const seeded = await rig.store.writeRepair(seedSnapshot([issue]), null);
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const results: MatrixCellResultV1[] = [];
      for (const observedModel of ["gpt-6-luna", "gpt-reserve"]) {
        const { result } = await wave(
          rig,
          modelReturning(portOk(throttledReceipt(observedModel))).port,
        );
        results.push(result);
        assert.equal(await readmit(rig, ACTUAL.runtimeSha as GitSha), 1);
      }
      const state = await snapshot(rig);
      const wire = JSON.parse(JSON.stringify(state));
      assert.deepEqual(
        JSON.parse(JSON.stringify(gen76.parseState(wire))),
        wire,
        "the generation-76 state parser accepts the written snapshot unchanged",
      );
      for (const result of results) {
        const cellWire = JSON.parse(JSON.stringify(result));
        assert.deepEqual(
          JSON.parse(JSON.stringify(gen76.parseCell(cellWire))),
          cellWire,
          "the generation-76 cell-result parser accepts the cell artifact",
        );
      }
    } finally {
      await rig.cleanup();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
