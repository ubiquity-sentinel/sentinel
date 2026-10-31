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
import { loadL79Modules } from "../host/l79-launcher-source.ts";
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

/**
 * True only when both rollback trees can be read here: the commit exists and
 * L79's tree is fully extractable (a partial clone cannot fetch it offline).
 */
async function l79Extractable(): Promise<boolean> {
  try {
    const loaded = await loadL79Modules([]);
    await loaded.dispose();
    return true;
  } catch {
    return false;
  }
}
const r79Available = await gen79Available();
const l79Ready = await l79Extractable();
const HOUR = 60 * MINUTE;
const ID = "issue-1";

interface ParkV1 {
  message: string;
  rig: CapRigV1;
  written: RepairStateSnapshotV1[];
}

/**
 * The historical parks, built directly: the retired ceiling no longer writes
 * them, but generation 79 must still parse and ignore the shapes already in
 * durable state. Each snapshot is the exact shape the ceiling wrote (an
 * `other` blocker with the fixed message; PR, head, receipts and charges
 * kept).
 */
async function parks(): Promise<ParkV1[]> {
  const clean = completedReceipt(3, SHA3, "clean");
  const rejected = (() => {
    const receipt = completedReceipt(3, SHA3, "p1");
    return {
      ...receipt,
      findings: receipt.findings.map((finding) => ({
        ...finding,
        severity: "P0" as const,
        message: "P0 finding",
      })),
      unresolvedSeverities: ["P0" as const],
    };
  })();
  const specs: Array<{ message: string; options: CapRigOptionsV1 }> = [
    {
      message: CAP_UNREVIEWED,
      options: { reviewRounds: 3, reservations: reviewCharges(ID, 3) },
    },
    {
      message: CAP_REJECTED,
      options: {
        reviewRounds: 3,
        reservations: reviewCharges(ID, 3),
        reviews: [rejected],
      },
    },
    {
      message: CAP_UNACCEPTED,
      options: {
        reviewRounds: 3,
        reservations: reviewCharges(ID, 3),
        reviews: [completedReceipt(3, SHA3, "unaccepted")],
      },
    },
    {
      message: CAP_BASE_MOVED,
      options: {
        reviewRounds: 3,
        nextStep: "delivery",
        reservations: reviewCharges(ID, 3),
        reviews: [clean],
        record: {
          target: {
            base: SHA2,
            branch: "sentinel/repair/issue-1",
            checkpoint: null,
            head: SHA3,
            pr: PR,
          },
        },
      },
    },
    {
      message: CAP_REVIEWED,
      options: {
        reviewRounds: 3,
        reservations: reviewCharges(ID, 3),
        reviews: [clean],
      },
    },
  ];
  const out: ParkV1[] = [];
  for (const spec of specs) {
    const rig = await capRig(spec.options);
    const before = await rig.snapshot();
    const record = {
      ...before.work[0]!,
      nextStep: "blocked" as const,
      wait: null,
      blocker: { kind: "other" as const, message: spec.message, since: T0 },
    };
    const next = { ...before, sequence: before.sequence + 1, work: [record] };
    const current = await rig.state.readRepair();
    assert.ok(current.ok && current.value.status === "found");
    const written = await rig.state.writeRepair(next, current.value.head);
    assert.ok(
      written.ok && written.value.status === "applied",
      JSON.stringify(written),
    );
    out.push({ message: spec.message, rig, written: [structuredClone(next)] });
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
  ignore: !r79Available,
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
  ignore: !r79Available,
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
  ignore: !(r79Available && l79Ready),
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
