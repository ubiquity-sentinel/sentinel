/**
 * One maintenance pass continues after a write. Live (2026-10-16): since
 * generation 78 nearly every pass began with a maintenance ingest and
 * returned on it, so conflict re-admissions, merges and release requests
 * starved. The runner now re-reads state on the exact head each applied
 * write left, rebuilds its pass facts there and runs the remaining phases in
 * their fixed order, each once, each with its own expected-head CAS; a phase
 * that is not continuable, a refused or moved head, a late clock or a thrown
 * error stops the pass cleanly with the writes it already made.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import * as runner from "../../ops/hosted-autonomy-runner.ts";
import { CONFLICT_READMISSION_DETAIL } from "../../ops/hosted-autonomy-conflict-retries.ts";
import {
  CANDIDATE_REF_IDENTITY_MISMATCH,
} from "../../ops/hosted-autonomy-candidate-refs.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { REPO, workRecord } from "../state/helpers.ts";
import {
  assertCasChain,
  assertRollbackReads,
  assertStatusScans,
  captureMain,
  CONFLICT,
  conflictBlocked,
  GONE,
  goneRecord,
  HEAD,
  MERGE,
  NOW,
  passDeps,
  RecordingState,
  resultLine,
  SELF_ID,
  SHA1,
  SHA2,
  snapshotWith,
  surfaces,
  T0,
} from "./hosted-autonomy-continuation-fixtures.ts";
import { deliveryRecord } from "./hosted-autonomy-fixtures.ts";

interface HistoricalAutonomy {
  runHostedAutonomy: typeof runner.runHostedAutonomy;
  captureMain: typeof captureMain;
  CurrentMatrixRecoveryIntegrityFailure:
    typeof import("../../ops/hosted-autonomy-producer-recovery.ts").CurrentMatrixRecoveryIntegrityFailure;
}

/** Keep the real runner, main and injected integrity class in one historical graph. */
function historicalTest(
  name: string,
  scenario: (runtime: HistoricalAutonomy) => Promise<void>,
) {
  Deno.test(
    name,
    () =>
      withHostedProductionPolicy(
        DORMANT_HOSTED_SUPERVISOR_POLICY,
        async (graph) => {
          const { runHostedAutonomy } = await graph.runner();
          const { runHostedAutonomyMain } = await graph.maintenanceMain();
          const { CurrentMatrixRecoveryIntegrityFailure } = await graph
            .producerRecovery();
          await scenario({
            runHostedAutonomy,
            captureMain: (deps) => captureMain(deps, runHostedAutonomyMain),
            CurrentMatrixRecoveryIntegrityFailure,
          });
        },
      ),
  );
}

const INITIAL = "1".repeat(40) as GitSha;
/** Continued phases start at most this long after the pass began. */
const LIMIT_MS = 600_000;
const READMIT = `retry:${CONFLICT}:readmit:${CONFLICT_READMISSION_DETAIL}`;

async function threeDue() {
  return new RecordingState(
    snapshotWith([await conflictBlocked(), deliveryRecord(), goneRecord()]),
  );
}

const indexOf = (actions: readonly string[], prefix: string) =>
  actions.findIndex((action) => action.startsWith(prefix));

historicalTest(
  "continuation: a re-admission, a merge with its release request and a retirement land in one pass on fresh heads",
  async ({ runHostedAutonomy }) => {
    const state = await threeDue();
    const github = surfaces(state);
    const result = await runHostedAutonomy(await passDeps(state, github));
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(state.log.length, 3, JSON.stringify(result.actions));
    assertCasChain(state.log, INITIAL);
    const [retried, delivered, retired] = state.log;
    // The retry write re-admits the conflict candidate only.
    assert.equal(
      retried.next.work.find((row) => row.id === CONFLICT)?.nextStep,
      "work",
    );
    assert.equal(retried.next.releaseRequests.length, 0);
    // The delivery write builds on exactly the snapshot the retry wrote.
    assert.deepEqual(
      delivered.next.work.find((row) => row.id === CONFLICT),
      retried.next.work.find((row) => row.id === CONFLICT),
    );
    assert.equal(delivered.next.sequence, retried.next.sequence + 1);
    assert.equal(delivered.next.releaseRequests.length, 1);
    assert.equal(delivered.next.releaseRequests[0].source.head, HEAD);
    // One merge, after the retry write and before the request write.
    assert.deepEqual(github.merges, [1]);
    // The retirement follows on the delivery write's head.
    assert.equal(
      retired.next.work.find((row) => row.id === GONE)?.nextStep,
      "blocked",
    );
    assert.equal(retired.next.releaseRequests.length, 1);
    // One aggregate line: the first write's before head, the last applied head.
    assert.equal(result.reason, "retired_records");
    assert.equal(result.beforeHead, INITIAL);
    assert.equal(result.appliedHead, state.head);
    assert.deepEqual(result.revisions, [MERGE]);
    const order = [
      READMIT,
      `merge:${SELF_ID}:pr=51:sha=${MERGE}`,
      `request:${SELF_ID}:`,
      `retire:${GONE}:issue=641`,
    ].map((prefix) => indexOf(result.actions, prefix));
    assert.ok(order.every((at) => at >= 0), JSON.stringify(result.actions));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(
      !result.actions.some((action) => action.startsWith("continuation:")),
    );
    await assertRollbackReads(state.log);
  },
);

historicalTest(
  "continuation: protected main prints the one aggregate result line and exits zero",
  async ({ captureMain }) => {
    const state = await threeDue();
    const { exit, lines } = await captureMain(
      await passDeps(state, surfaces(state)),
    );
    assert.equal(exit, 0);
    const result = resultLine(lines);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "retired_records");
    assert.equal(result.appliedHead, state.head);
    assert.equal(state.log.length, 3);
    assert.deepEqual(Object.keys(result).sort(), [
      "actions",
      "appliedHead",
      "beforeHead",
      "kind",
      "reason",
      "revisions",
      "status",
    ]);
    // No other line can be taken for a status record, by any scanner.
    for (const line of lines) {
      if (line.kind !== "hosted_autonomy") {
        assert.equal("status" in line, false);
      }
    }
    assert.ok(
      lines.some((line) => line.kind === "sentinel_autonomy_continuation"),
    );
    await assertStatusScans(lines);
  },
);

historicalTest(
  "continuation: a refused compare-and-swap in a later phase stops the pass with its earlier writes",
  async ({ runHostedAutonomy, captureMain }) => {
    const state = await threeDue();
    state.refuse.add(2);
    const github = surfaces(state);
    const result = await runHostedAutonomy(await passDeps(state, github));
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "retried");
    assert.equal(result.beforeHead, INITIAL);
    assert.equal(result.appliedHead, state.log[0].head);
    assert.equal(state.log.length, 2);
    assert.equal(state.log[1].status, "conflict");
    assertCasChain(state.log, INITIAL);
    assert.equal(result.actions.at(-1), "continuation:delivery:write_conflict");
    // Nothing after the refusal: no phase read, no closure, no retirement. The
    // one read is shared by the state-free passes that run once after the
    // whole chain unless it failed and never write state: the review
    // follow-up pass, the base-repair pass and the CI resume pass.
    assert.equal(state.readsSinceWrite, 1);
    assert.equal(state.writes, 2);
    assert.deepEqual(github.closed, []);
    assert.equal(
      state.snapshot.work.find((row) => row.id === GONE)?.nextStep,
      "work",
    );
    const again = await threeDue();
    again.refuse.add(2);
    const { exit, lines } = await captureMain(
      await passDeps(again, surfaces(again)),
    );
    assert.equal(exit, 0);
    assert.deepEqual(resultLine(lines), JSON.parse(JSON.stringify(result)));
  },
);

historicalTest(
  "continuation: a head moved between phases stops before the next phase reads anything",
  async ({ runHostedAutonomy }) => {
    const state = await threeDue();
    // The retry write's readback is the first read; the runner's re-read the
    // second.
    state.moveHeadOnRead = 2;
    const github = surfaces(state);
    const result = await runHostedAutonomy(await passDeps(state, github));
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "retried");
    assert.equal(state.log.length, 1);
    assert.equal(result.actions.at(-1), "continuation:delivery:head_changed");
    assert.deepEqual(github.merges, []);
    assert.equal(github.approvals, 0);
  },
);

historicalTest(
  "continuation: past the start limit the next phase defers; at the limit it still runs",
  async ({ runHostedAutonomy }) => {
    for (
      const [late, merges, writes] of [[LIMIT_MS + 1, 0, 1], [LIMIT_MS, 1, 3]]
    ) {
      const state = await threeDue();
      const github = surfaces(state);
      const result = await runHostedAutonomy(
        await passDeps(
          state,
          github,
          () => NOW + (state.writes === 0 ? 0 : late),
        ),
      );
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(github.merges.length, merges, `elapsed ${late}`);
      assert.equal(state.log.length, writes, `elapsed ${late}`);
      assert.equal(
        result.actions.includes("continuation:delivery:deferred_deadline"),
        merges === 0,
      );
    }
    // An unreadable clock after a write is past the limit too.
    const state = await threeDue();
    const github = surfaces(state);
    const result = await runHostedAutonomy(
      await passDeps(
        state,
        github,
        () => state.writes === 0 ? NOW : Number.NaN,
      ),
    );
    assert.equal(
      result.actions.at(-1),
      "continuation:delivery:deferred_deadline",
    );
    assert.deepEqual(github.merges, []);
  },
);

historicalTest(
  "continuation: a late no-write pass defers safely and a fresh pass remains eligible",
  async ({ runHostedAutonomy }) => {
    const state = new RecordingState(snapshotWith([deliveryRecord()]));
    const github = surfaces(state, { checkGreen: false });
    const before = await state.readRepair();
    let calls = 0;
    const result = await runHostedAutonomy(
      await passDeps(
        state,
        github,
        () => NOW + (calls++ === 0 ? 0 : 10 * LIMIT_MS),
      ),
    );
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(result.reason, "no_change");
    assert.ok(
      result.actions.some((action) => action.endsWith(":deferred_deadline")),
    );
    assert.deepEqual(await state.readRepair(), before);
    assert.equal(state.log.length, 0);
    const fresh = await runHostedAutonomy(
      await passDeps(state, github, () => NOW + 10 * LIMIT_MS + 1),
    );
    assert.equal(fresh.reason, "checks_pending");
    assert.ok(fresh.actions.includes(`delivery:${SELF_ID}:checks_pending`));
    assert.deepEqual(await state.readRepair(), before);
  },
);

historicalTest(
  "continuation: a candidate-ref revalidation still ends the pass before any delivery decision",
  async ({ runHostedAutonomy }) => {
    const id = "issue-ubiquity-ai.ubq.fi-642";
    const operationKey = implementationIntentKey("ab".repeat(32));
    const revalidated = workRecord(id, {
      source: { kind: "issue", id: "642", revision: SHA1 },
      related: { incidentId: null, issueNumber: 642 },
      nextStep: "blocked",
      blocker: {
        kind: "other",
        message: CANDIDATE_REF_IDENTITY_MISMATCH,
        since: T0,
      },
      target: {
        base: SHA1,
        branch: candidateBranch(id as never),
        checkpoint: null,
        head: SHA2,
        pr: null,
        candidateState: {
          preserved: {
            operationKey,
            base: SHA1,
            head: SHA2,
            ref: await candidatePreservationRef(
              REPO,
              id as never,
              operationKey,
            ),
          },
          publishedHead: SHA2,
        },
      },
    });
    const state = new RecordingState(
      snapshotWith([revalidated, await conflictBlocked(), deliveryRecord()]),
    );
    const github = surfaces(state);
    const gateway = github.githubFor(REPO);
    const base = gateway.readBaseTip.bind(gateway);
    gateway.readBaseTip = (branch: string) =>
      branch === candidateBranch(id as never)
        ? Promise.resolve(SHA2)
        : base(branch);
    const result = await runHostedAutonomy(await passDeps(state, github));
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "applied");
    assert.ok(result.actions.includes(`revalidate:${id}:cleared`));
    assert.equal(state.log.length, 1);
    assert.deepEqual(github.merges, []);
    assert.equal(github.approvals, 0);
    assert.ok(
      !result.actions.some((action) => action.startsWith("continuation:")),
    );
  },
);

historicalTest(
  "continuation: an error thrown in a continued phase defers it and keeps the earlier write",
  async (
    { runHostedAutonomy, captureMain, CurrentMatrixRecoveryIntegrityFailure },
  ) => {
    const state = await threeDue();
    const github = surfaces(state, {
      throwAfterWrite: () => new Error("transport torn down"),
    });
    const { exit, lines } = await captureMain(await passDeps(state, github));
    assert.equal(exit, 0);
    const result = resultLine(lines);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "retried");
    assert.equal(result.appliedHead, state.log[0].head);
    assert.equal(state.log.length, 1);
    assert.equal(
      result.actions.at(-1),
      "continuation:delivery:deferred_unexpected_error",
    );
    assert.deepEqual(github.merges, []);
    assert.deepEqual(
      lines.filter((line) => line.kind === "sentinel_autonomy_deferred"),
      [{
        kind: "sentinel_autonomy_deferred",
        reason: "unexpected_error_deferred",
        category: "unexpected_error",
      }],
    );
    await assertStatusScans(lines);
    // An integrity fault still fails closed, never a deferral.
    const strict = await threeDue();
    await assert.rejects(
      async () =>
        runHostedAutonomy(
          await passDeps(
            strict,
            surfaces(strict, {
              throwAfterWrite: () =>
                new CurrentMatrixRecoveryIntegrityFailure(
                  "current matrix readback incomplete",
                  INITIAL,
                  null,
                  null,
                ),
            }),
          ),
        ),
      CurrentMatrixRecoveryIntegrityFailure,
    );
  },
);

Deno.test("continuation: the start limit leaves every continued phase inside the maintenance job", async () => {
  const pins = runner as unknown as Record<string, number | undefined>;
  const deadline = pins.HOSTED_AUTONOMY_PASS_DEADLINE_MS;
  const reserve = pins.HOSTED_AUTONOMY_PHASE_RESERVE_MS;
  assert.equal(typeof deadline, "number");
  assert.equal(typeof reserve, "number");
  const workflow = await Deno.readTextFile(
    new URL("../../.github/workflows/supervisor.yml", import.meta.url),
  );
  const job = workflow.slice(workflow.indexOf("\n  maintenance:\n"));
  const minutes = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(job)?.[1]);
  assert.equal(minutes, 15);
  // A minute of job setup before the step and teardown after it.
  assert.ok(deadline! + 60_000 <= minutes * 60_000);
  // The 300 s history walk plus two minutes of ordinary phases still fit
  // before the start limit, so the live ingest pass reaches retry and
  // delivery.
  assert.ok(deadline! - reserve! >= 300_000 + 120_000);
  assert.equal(deadline! - reserve!, LIMIT_MS);
});
