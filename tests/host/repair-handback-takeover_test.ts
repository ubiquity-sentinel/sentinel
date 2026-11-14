/**
 * The serial repair job steps the records its own run's repository cells
 * handed back, in the same run (issue #328; live 2026-11-13: PR #389 lost a
 * supervisor cycle at its refresh and another at its review start, #399 and
 * #400 opened about an hour after their code was ready).
 *
 * Three published heads on a moved base, all delegated: the cell hands back
 * the line front (its refresh is a trusted effect). The REAL aggregate and
 * step loop run over in-memory state, a fake repository and a fake artifact
 * transport; no network, no model call.
 */
import assert from "node:assert/strict";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions.ts";
import type {
  MatrixArtifactTransportV1,
  RepairHandbackRequestV1,
  RepairHandbackV1,
} from "../../src/host/matrix-artifact-port.ts";
import { scanChildStatusRecords } from "../../src/host/hosted-runtime-status.ts";
import { runActionsMatrixAggregateCycles } from "../../src/host/matrix-aggregate.ts";
import { publishRepairFanoutOrNone } from "../../src/host/repair-fanout-host.ts";
import { REPAIR_HANDBACK_KIND } from "../../src/host/repair-handback-takeover.ts";
import { STEP_LINE_KIND } from "../../src/repair/step-line.ts";
import { queueRig } from "../repair/delivery-queue-rig.ts";
import { captured, OLD_STAMP } from "../repair/repository-pass-rig.ts";
import { MINUTE, sha } from "../repair/review-round-cap-rig.ts";
import { REPO, SHA1, SHA2, T0 } from "../state/helpers.ts";
import { releaseSnapshot } from "./hosted-autonomy-rig.ts";

const RUN = { runId: 41, runAttempt: 1, launcherSha: SHA1 };
type Rig = Awaited<ReturnType<typeof queueRig>>;

async function line(): Promise<Rig> {
  const rig = await queueRig(3, {
    tip: sha(0x777),
    shape: (records) =>
      records.map((record) => ({ ...record, stepInputs: OLD_STAMP })),
  });
  // The aggregate reads both authoritative state surfaces.
  rig.state.setRelease(releaseSnapshot());
  return rig;
}

async function inTemp(body: (work: string) => Promise<void>) {
  const work = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-repair-test-handback-",
  });
  try {
    await body(work);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

/** The planner's fan-out plan; returns the matrix root and plan digest. */
async function published(rig: Rig, work: string) {
  const root = work + "/planner/.sentinel-matrix";
  const output = work + "/github-output";
  await Deno.writeTextFile(output, "");
  await Deno.mkdir(root, { recursive: true });
  await publishRepairFanoutOrNone({
    state: rig.state,
    configs: rig.deps.configs,
    run: RUN,
    artifactRoot: root,
    output,
  });
  const digest = (await Deno.readTextFile(output)).split("\n")
    .find((row) => row.startsWith("repairPlanDigest="))!
    .slice("repairPlanDigest=".length);
  assert.match(digest, /^[0-9a-f]{64}$/);
  return { root, digest };
}

function aggregateInput(rig: Rig, artifactRoot: string) {
  return {
    ...rig.deps,
    controllerSha: SHA2,
    deadline: rig.clock.now() + 90 * MINUTE,
    stepLimit: Infinity,
    modelStartsEnabled: true,
    composeGithub: () => rig.github,
    host: {
      execution: {
        id: "41:1:repair",
        runId: 41,
        runAttempt: 1,
        launcherSha: SHA1,
        purpose: "ordinary" as const,
        revision: SHA2,
        generation: 3,
        releaseId: null,
        createdAt: T0,
      },
      run: RUN,
      artifactRoot,
      sourcePathFor: () => "/unused",
      expectedProvider: "unused",
      createArtifactTransport: () => {
        throw new Error("the injected transport is used");
      },
    },
  } as unknown as ActionsTargetCyclesInputV1;
}

/** No matrix producer; the cells' hand-backs as the transport reads them. */
function transport(
  handbacks: readonly RepairHandbackV1[] | null | undefined,
  asked: RepairHandbackRequestV1[] = [],
): MatrixArtifactTransportV1 {
  return {
    recover: () => Promise.resolve([]),
    ...(handbacks === undefined ? {} : {
      repairHandbacks: (request: RepairHandbackRequestV1) => {
        asked.push(request);
        return Promise.resolve(handbacks);
      },
    }),
  };
}

async function aggregate(
  rig: Rig,
  work: string,
  reader: MatrixArtifactTransportV1,
  overrides: Partial<ActionsTargetCyclesInputV1> = {},
) {
  const { root, digest } = await published(rig, work);
  const { lines } = await captured(() =>
    runActionsMatrixAggregateCycles(
      { ...aggregateInput(rig, root), ...overrides },
      reader,
      { planDigest: "d".repeat(64), repairPlanDigest: digest },
      { maxWaitMs: 20 * MINUTE },
    )
  );
  return {
    digest,
    stepped: lines.filter((entry) => entry.kind === STEP_LINE_KIND)
      .map((entry) => entry.recordId),
    handback: lines.filter((entry) => entry.kind === REPAIR_HANDBACK_KIND),
  };
}

const FRONT: RepositoryIdentityV1 = REPO;

Deno.test("hand-back takeover: the serial pass steps the record a completed cell handed back in the same run", async () => {
  const rig = await line();
  await inTemp(async (work) => {
    const asked: RepairHandbackRequestV1[] = [];
    const { digest, stepped, handback } = await aggregate(
      rig,
      work,
      transport([{ repository: FRONT, records: ["issue-1"] }], asked),
    );
    // Its refresh ran on the trusted path now, not on the next plan.
    assert.ok(stepped.includes("issue-1"), JSON.stringify(stepped));
    assert.ok(rig.github.refreshes >= 1);
    // The heads the cell kept stay its own: never stepped here.
    assert.deepEqual(stepped.filter((id) => id !== "issue-1"), []);
    // One advisory line, never read as the child's status record.
    assert.deepEqual(handback, [{
      kind: REPAIR_HANDBACK_KIND,
      outcome: "read",
      records: 1,
    }]);
    assert.deepEqual(
      scanChildStatusRecords(JSON.stringify(handback[0])),
      { kind: "none" },
    );
    // The read is bound to this run, its runtime and its plan.
    assert.equal(asked.length, 1);
    assert.equal(asked[0].planDigest, digest);
    assert.deepEqual(asked[0].run, RUN);
    assert.deepEqual(asked[0].runtime, { revision: SHA2, generation: 3 });
  });
});

Deno.test("hand-back takeover: a hand-back of a target whose cycle already ended is not counted as woken", async () => {
  const rig = await line();
  await inTemp(async (work) => {
    // The target's preparation failed: its cycle ended before the read.
    const { stepped, handback } = await aggregate(
      rig,
      work,
      transport([{ repository: FRONT, records: ["issue-1"] }]),
      { prepareTarget: () => Promise.reject(new Error("checkout failed")) },
    );
    assert.deepEqual(stepped, []);
    assert.equal(rig.github.refreshes, 0);
    assert.deepEqual(handback, [{
      kind: REPAIR_HANDBACK_KIND,
      outcome: "read",
      records: 0,
    }]);
  });
});

Deno.test("hand-back takeover: without a hand-back every delegated record stays the cells'", async () => {
  for (
    const handbacks of [
      undefined,
      null,
      [],
      // Not delegated by this plan, or not this repository's: never woken.
      [{ repository: FRONT, records: ["issue-9"] }],
      [{
        repository: { ...FRONT, name: "elsewhere" },
        records: ["issue-1"],
      }],
    ]
  ) {
    const rig = await line();
    await inTemp(async (work) => {
      const { stepped } = await aggregate(rig, work, transport(handbacks));
      assert.deepEqual(stepped, [], JSON.stringify(handbacks));
      assert.equal(rig.github.refreshes, 0);
    });
  }
});
