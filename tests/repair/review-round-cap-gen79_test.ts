/**
 * Rollback of the hard review-round ceiling to generation 79. Generation 80
 * keeps R79 (`GEN79_RUNTIME`) as its runtime rollback target and L79 (the
 * live launcher) as its launcher rollback target, so every state the ceiling
 * writes must be accepted by their own code and left alone by it:
 *
 * - R79's strict parsers accept every snapshot written on the way to each of
 *   the five parks (no new state shape: an `other` blocker with a fixed
 *   message; PR, head, evidence, receipts and charges kept);
 * - R79's own repair loop (serial and matrix-owned) and matrix readiness treat
 *   every park as idle: no request, reservation, push, merge, model start or
 *   state change, while the base keeps moving;
 * - L79's planners (retry table, base-refresh re-admission) plan nothing for
 *   any park, and none of L79's or R79's blocker matchers (retry, CI,
 *   conflict, credential, mismatch, preservation, historical, issue-48 and
 *   task-acceptance) takes a park message.
 *
 * The cases are ignored in a checkout without R79 or L79.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { REVIEW_ROUND_CEILING_MESSAGES } from "../../src/repair/review-round-cap.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { assertGen79Parses, gen79Available } from "../state/gen77-contracts.ts";
import { loadGen79Modules } from "../host/gen77-runtime-source.ts";
import { l79Available, loadL79Modules } from "../host/l79-launcher-source.ts";
import {
  CAP_BASE_MOVED,
  CAP_REJECTED,
  CAP_REVIEWED,
  CAP_UNACCEPTED,
  CAP_UNREVIEWED,
  capRig,
  type CapRigOptionsV1,
  type CapRigV1,
  completedReceipt,
  MINUTE,
  PR,
  reviewCharges,
  sha,
} from "./review-round-cap-rig.ts";

const available = await gen79Available() && await l79Available();
const HOUR = 60 * MINUTE;
const ID = "issue-1";

/** A rig whose every repair-state write is retained for the parser proof. */
async function recordingRig(options: CapRigOptionsV1 = {}) {
  const rig = await capRig(options);
  const written: RepairStateSnapshotV1[] = [];
  const write = rig.state.writeRepair.bind(rig.state);
  rig.state.writeRepair = (next, head) => {
    written.push(structuredClone(next));
    return write(next, head);
  };
  return { rig, written };
}

interface ParkV1 {
  message: string;
  rig: CapRigV1;
  written: RepairStateSnapshotV1[];
}

async function runs(rig: CapRigV1, count: number) {
  for (let run = 0; run < count; run++) {
    await rig.run();
    rig.clock.advance(16 * MINUTE);
  }
}

/** Each park, produced by this tree's own loop. */
async function parks(): Promise<ParkV1[]> {
  const out: ParkV1[] = [];
  const atRound3 = (mode: "p1" | "missing_acceptance") =>
    recordingRig({
      reviewRounds: 3,
      nextStep: "review",
      wait: { reason: "review_pending", since: T0 - MINUTE, until: T0 },
      reservations: reviewCharges(ID, 3),
    }).then((made) => {
      made.rig.github.bind(3);
      made.rig.github.reviewMode = mode;
      return made;
    });
  {
    const made = await recordingRig();
    made.rig.github.reviewMode = "no_verdict";
    await runs(made.rig, 5);
    out.push({ message: CAP_UNREVIEWED, ...made });
  }
  {
    const made = await atRound3("p1");
    await runs(made.rig, 1);
    out.push({ message: CAP_REJECTED, ...made });
  }
  {
    const made = await atRound3("missing_acceptance");
    await runs(made.rig, 1);
    out.push({ message: CAP_UNACCEPTED, ...made });
  }
  {
    const made = await recordingRig();
    for (let move = 0; move < 4; move++) {
      await runs(made.rig, 2);
      made.rig.github.remoteBase = sha(0x2100 + move);
    }
    await runs(made.rig, 1);
    out.push({ message: CAP_BASE_MOVED, ...made });
  }
  {
    const made = await recordingRig({
      reviewRounds: 3,
      nextStep: "delivery",
      reservations: reviewCharges(ID, 3),
      reviews: [completedReceipt(3, SHA3, "clean")],
      record: {
        intent: {
          kind: "merge",
          key: `merge:${PR}:${SHA3}`,
          startedAt: T0 - 30 * MINUTE,
          branch: "sentinel/repair/issue-1",
          expectedHead: SHA3,
          observedBase: SHA1,
          pr: PR,
          requestId: null,
          resultId: null,
        },
      },
    });
    made.rig.github.remoteBase = SHA2;
    await runs(made.rig, 1);
    out.push({ message: CAP_BASE_MOVED, ...made });
  }
  {
    // An accepted head returned to work (a CI fix) with no round left.
    const made = await recordingRig({
      reviewRounds: 3,
      reservations: reviewCharges(ID, 3),
      reviews: [completedReceipt(3, SHA3, "clean")],
    });
    await runs(made.rig, 1);
    out.push({ message: CAP_REVIEWED, ...made });
  }
  for (const park of out) {
    const work = await park.rig.work();
    assert.equal(work.nextStep, "blocked", park.message);
    assert.equal(work.blocker?.kind, "other");
    assert.equal(work.blocker?.message, park.message);
  }
  return out;
}

Deno.test({
  name:
    "rollback to generation 79: R79's parsers accept every snapshot the ceiling writes",
  ignore: !available,
  async fn() {
    for (const park of await parks()) {
      assert.ok(park.written.length > 0);
      for (const snapshot of park.written) await assertGen79Parses(snapshot);
      await assertGen79Parses(await park.rig.snapshot());
    }
  },
});

Deno.test({
  name:
    "rollback to generation 79: R79's own loop and matrix readiness leave every park alone",
  ignore: !available,
  async fn() {
    const loaded = await loadGen79Modules([
      "src/repair/loop.ts",
      "src/budget/mod.ts",
      "src/repair/github-cooldown.ts",
    ]);
    // deno-lint-ignore no-explicit-any
    const [loop, budget, cooldown] = loaded.modules as any[];
    const r79Deps = (rig: CapRigV1, externalImplementations: boolean) => ({
      ...rig.deps,
      githubCooldown: new cooldown.DurableGitHubCooldownGate({
        state: rig.state,
        clock: rig.clock,
      }),
      budget: new budget.RollingStartBudget({
        clock: rig.clock,
        state: rig.state,
        configs: rig.deps.configs,
      }),
      externalImplementations,
    });
    try {
      // Control: the harness really runs R79, which has no ceiling of its own
      // and requests a sixth round for a record that is not parked.
      {
        const control = await capRig({
          reviewRounds: 5,
          reservations: reviewCharges(ID, 5, { head: SHA1 }),
        });
        const outcome = await loop.runRepairCycle(r79Deps(control, false), {
          deadline: control.clock.now() + HOUR,
          stepLimit: 16,
        });
        assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
        assert.equal(control.github.requests, 1, "R79 requests a sixth round");
      }
      for (const park of await parks()) {
        const { rig } = park;
        const before = await rig.snapshot();
        const record = before.work[0]!;
        assert.equal(
          loop.isMatrixImplementationReadyV1(
            record,
            before,
            rig.deps.configs[0],
            rig.clock.now(),
            true,
            true,
          ),
          false,
          `${park.message}: R79 grants no matrix cell`,
        );
        const counts = () => ({
          requests: rig.github.requests,
          merges: rig.github.merges,
          refreshes: rig.github.refreshes,
          pushes: rig.github.pushes.length,
          models: rig.model.requests.length,
        });
        const callsBefore = counts();
        for (const externalImplementations of [false, true]) {
          // The base keeps moving and time passes: nothing may wake the park.
          rig.github.remoteBase = sha(
            0x4000 + (externalImplementations ? 1 : 0),
          );
          rig.clock.advance(16 * MINUTE);
          const outcome = await loop.runRepairCycle(
            r79Deps(rig, externalImplementations),
            { deadline: rig.clock.now() + HOUR, stepLimit: 16 },
          );
          assert.notEqual(
            outcome.status,
            "state_error",
            JSON.stringify(outcome),
          );
        }
        assert.deepEqual(
          await rig.snapshot(),
          before,
          `${park.message}: R79 writes nothing`,
        );
        assert.deepEqual(
          counts(),
          callsBefore,
          `${park.message}: R79 calls nothing`,
        );
      }
    } finally {
      await loaded.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 79: L79's planners and every L79/R79 blocker matcher leave every park alone",
  ignore: !available,
  async fn() {
    const launcher = await loadL79Modules([
      "ops/hosted-autonomy.ts",
      "ops/hosted-autonomy-policy.ts",
      "ops/hosted-autonomy-conflict-retries.ts",
      "ops/runtime-mismatch-recovery-disposition.ts",
      "ops/issue48-review-quota-recovery.ts",
      "ops/historical-retry-disposition.ts",
      "ops/hosted-autonomy-candidate-refs.ts",
      "ops/hosted-autonomy-blocked-candidate.ts",
    ]);
    const runtime = await loadGen79Modules(["src/repair/review-gate.ts"]);
    try {
      const [
        autonomy,
        policy,
        conflicts,
        mismatch,
        issue48,
        historical,
        refs,
        blocked,
        // deno-lint-ignore no-explicit-any
      ] = launcher.modules as any[];
      // deno-lint-ignore no-explicit-any
      const [gate] = runtime.modules as any[];
      const prefixes: string[] = [
        ...(policy.HOSTED_AUTONOMY_RETRYABLE as { prefix: string }[]).map(
          (rule) => rule.prefix,
        ),
        policy.HOSTED_AUTONOMY_CI_FAILED_PREFIX,
        policy.HOSTED_AUTONOMY_CI_UNATTRIBUTED_PREFIX,
        mismatch.MISMATCH_DISPOSITION_BLOCKER_PREFIX,
        issue48.ISSUE48_QUOTA_BLOCKER_PREFIX,
        issue48.ISSUE48_QUOTA_BUDGET_BLOCKER_PREFIX,
        issue48.ISSUE48_QUOTA_CANDIDATE_BLOCKER_PREFIX,
        issue48.ISSUE48_QUOTA_ADMISSION_BLOCKER_PREFIX,
        // R79's own historical review-ceiling re-arm.
        "review rounds exhausted without an accepted verdict (",
      ];
      const exact: string[] = [
        ...(autonomy.BASE_REFRESH_AUTH_BLOCKERS as Set<string>),
        historical.HISTORICAL_RETRY_DISPOSITION_MESSAGE,
        refs.CANDIDATE_REF_IDENTITY_MISMATCH,
        blocked.PRESERVATION_VALIDATION_REFUSED,
        gate.TASK_ACCEPTANCE_MISSING_DETAIL,
        gate.TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
      ];
      for (const prefix of prefixes) assert.equal(typeof prefix, "string");
      for (const message of exact) assert.equal(typeof message, "string");
      for (const message of REVIEW_ROUND_CEILING_MESSAGES) {
        for (const prefix of prefixes) {
          assert.ok(!message.startsWith(prefix), `${prefix} takes ${message}`);
        }
        assert.ok(!exact.includes(message), message);
        assert.ok(!conflicts.BASE_REFRESH_CONFLICT_BLOCKER.test(message));
        assert.ok(
          !/^base refresh failed [1-9][0-9]* consecutive times: /.test(message),
        );
      }
      for (const park of await parks()) {
        const before = await park.rig.snapshot();
        const record = before.work[0]!;
        // A moved base tip, and CI green on the parked head.
        const tips = new Map([[
          hostedRepositoryKey(record.repository),
          sha(0x5000),
        ]]);
        const denied: string[] = [];
        const plans = autonomy.planHostedRetries(
          before,
          park.rig.clock.now(),
          SHA1,
          tips,
          new Set(),
          (denial: { reason: string }) => denied.push(denial.reason),
          {
            ciGreenHeads: new Set(
              record.target.head === null ? [] : [
                `${
                  hostedRepositoryKey(record.repository)
                }@${record.target.head}`,
              ],
            ),
          },
        );
        assert.deepEqual(plans, [], `${park.message}: L79 plans no retry`);
        assert.deepEqual(
          autonomy.planBaseRefreshReadmissions(before, SHA1, new Set()),
          [],
          `${park.message}: L79 re-admits no refresh`,
        );
      }
    } finally {
      await launcher.dispose();
      await runtime.dispose();
    }
  },
});
