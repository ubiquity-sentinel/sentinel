import assert from "node:assert/strict";
import {
  createNativeReleaseBridgeState,
  createReleaseBridgeStateReadView,
  RELEASE_BRIDGE_STATE_REPOSITORY,
} from "../../src/host/release-bridge.ts";
import { verifyCommittedSettlement } from "../../src/host/vps-release.ts";
import { githubGitAuthEnv } from "../../src/host/local-github-auth.ts";
import { DenoGitRunner, type GitRunnerV1 } from "../../src/state/mod.ts";
import { asGitSha } from "../../src/contracts/brands.ts";
import { parseVpsReleaseRecordV1 } from "../../src/contracts/vps-release.ts";
import {
  parseVpsReceipt,
  vpsDigest,
  type VpsSettlement,
} from "../../src/contracts/vps-release-wire.ts";
import { vpsMutation } from "../../src/release/vps-controller.ts";
import { makeGitCtx, publishRepairRequest } from "../release/helpers.ts";

const fixture = parseVpsReleaseRecordV1(JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/vps/release-requested-v1.json", import.meta.url),
  ),
));

async function nativeHistoryRig() {
  const context = await makeGitCtx("release-bridge-history");
  const repairHead = await publishRepairRequest(context, fixture.request);
  const native = new DenoGitRunner(
    `${context.tmp}/git-home`,
    githubGitAuthEnv(
      "synthetic-native-history-token",
      RELEASE_BRIDGE_STATE_REPOSITORY,
    ),
  );
  const runner: GitRunnerV1 = {
    runGit: (args, options) =>
      native.runGit(
        args.map((value) =>
          value === RELEASE_BRIDGE_STATE_REPOSITORY ? context.remoteUrl : value
        ),
        options,
      ),
  };
  const state = createNativeReleaseBridgeState(
    "synthetic-native-history-token",
    {
      scratchDir: `${context.tmp}/native-state`,
      gitHome: `${context.tmp}/git-home`,
    },
    runner,
  );
  const initial = {
    version: "v1" as const,
    kind: "release_state_snapshot" as const,
    stateHead: null,
    sequence: 1,
    updatedAt: fixture.createdAt,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
    vpsReleases: [fixture],
  };
  const first = await state.writeRelease(initial, null);
  assert.ok(first.ok && first.value.status === "applied");
  const now = fixture.createdAt + 1000;
  const record = parseVpsReleaseRecordV1({
    ...fixture,
    phase: "failed",
    intent: { action: "fail", persistedAt: now },
    error: "acceptance_insufficient",
    updatedAt: now,
  });
  const failedSnapshot = {
    ...initial,
    stateHead: first.value.head,
    sequence: 2,
    updatedAt: now,
    vpsReleases: [record],
  };
  const failed = await state.writeRelease(failedSnapshot, first.value.head);
  assert.ok(failed.ok && failed.value.status === "applied");
  const original: VpsSettlement = {
    ...await vpsMutation(record.driver),
    stateRevision: failed.value.head,
    disposition: "failed",
    digest: await vpsDigest(record),
  };
  const terminal = parseVpsReceipt({
    ...record.driver,
    phase: "failed",
    sequence: 2,
    updatedAt: now,
    settlement: {
      stateRevision: original.stateRevision,
      disposition: original.disposition,
      digest: original.digest,
    },
    error: "acceptance_insufficient",
  });
  const snapshot = {
    ...failedSnapshot,
    stateHead: failed.value.head,
    sequence: 3,
    updatedAt: now + 1000,
  };
  const moved = await state.writeRelease(snapshot, failed.value.head);
  assert.ok(moved.ok && moved.value.status === "applied");
  const input = { ...original, ...await vpsMutation(terminal) };
  return {
    context,
    state,
    terminal,
    input,
    snapshot,
    head: moved.value.head,
    repairHead,
    now: now + 1000,
  };
}

Deno.test("release bridge history: native facade retains bound original ancestor reader without repair writing", async () => {
  const rig = await nativeHistoryRig();
  try {
    assert.equal("writeRepair" in rig.state, false);
    assert.equal(
      typeof rig.state.readReleaseAt,
      "function",
      "native bridge must retain history",
    );
    const readAt = rig.state.readReleaseAt!;
    const history = await readAt({
      commit: asGitSha(rig.input.stateRevision),
      expectedHead: rig.head,
    });
    assert.ok(history.ok && history.value.status === "found");
    assert.equal(history.value.head, rig.input.stateRevision);
    assert.equal(
      await verifyCommittedSettlement(
        rig.state,
        rig.terminal,
        rig.input,
        rig.now,
      ),
      true,
    );
  } finally {
    await rig.context.cleanup();
  }
});

Deno.test("release bridge history: production options wrapper settles original ancestor and refuses missing divergent or moved-head evidence", async () => {
  const rig = await nativeHistoryRig();
  try {
    const view = createReleaseBridgeStateReadView(rig.state);
    assert.equal("writeRelease" in view, false);
    assert.equal("writeRepair" in view, false);
    assert.equal(
      typeof view.readReleaseAt,
      "function",
      "production bridge options must retain history",
    );
    assert.equal(
      await verifyCommittedSettlement(view, rig.terminal, rig.input, rig.now),
      true,
    );
    const noHistory = createReleaseBridgeStateReadView({
      readRepair: () => rig.state.readRepair(),
      readRelease: () => rig.state.readRelease(),
    });
    assert.equal(
      await verifyCommittedSettlement(
        noHistory,
        rig.terminal,
        rig.input,
        rig.now,
      ),
      false,
    );
    assert.equal(
      await verifyCommittedSettlement(view, rig.terminal, {
        ...rig.input,
        digest: "f".repeat(64),
      }, rig.now),
      false,
    );
    const divergentInput = { ...rig.input, stateRevision: rig.repairHead };
    const divergentTerminal = {
      ...rig.terminal,
      settlement: {
        ...rig.terminal.settlement!,
        stateRevision: rig.repairHead,
      },
    };
    assert.equal(
      await verifyCommittedSettlement(
        view,
        divergentTerminal,
        divergentInput,
        rig.now,
      ),
      false,
      "repair commit is not release ancestry",
    );
    const moving = createReleaseBridgeStateReadView({
      readRepair: () => rig.state.readRepair(),
      readRelease: () => rig.state.readRelease(),
      readReleaseAt: async (input) => {
        const history = await rig.state.readReleaseAt!(input);
        const advanced = await rig.state.writeRelease({
          ...rig.snapshot,
          stateHead: rig.head,
          sequence: 4,
          updatedAt: rig.now + 1,
        }, rig.head);
        assert.ok(advanced.ok && advanced.value.status === "applied");
        return history;
      },
    });
    assert.equal(
      await verifyCommittedSettlement(
        moving,
        rig.terminal,
        rig.input,
        rig.now + 1,
      ),
      false,
    );
  } finally {
    await rig.context.cleanup();
  }
});
