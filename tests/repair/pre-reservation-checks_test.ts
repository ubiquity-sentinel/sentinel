/**
 * #333: every deterministic admission/preservation precondition is decided
 * BEFORE the implementation reservation. A refused record is never reserved
 * or charged and carries the precise check and reason code; a passing record
 * proceeds to the reservation exactly as before.
 */
import assert from "node:assert/strict";
import {
  deriveReservationId,
  RollingStartBudget,
} from "../../src/budget/mod.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  implementationIntent,
  prepareImplementationStart,
} from "../../src/repair/loop-implementation.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import {
  isPreservationRefusalMessage,
  isValidBranchName,
  POST_INFERENCE_CHECK_NAMES,
  PRE_RESERVATION_REFUSALS,
  PRE_RESERVATION_REFUSED_PREFIX,
  preReservationChecks,
  type PreReservationLiveFactsV1,
  preservationRefusalMessage,
} from "../../src/repair/pre-reservation-checks.ts";
import { setIntent, startAttempt } from "../../src/repair/transitions.ts";
import {
  PUBLICATION_FILE_BOUND_DETAIL,
  PUBLICATION_PROTECTED_DETAIL,
} from "../../src/github/snapshot-policy.ts";
import { reservation, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";

const BOUND = { maxDurationMs: 240_000, maxOutputChars: 200_000 };

async function facts(
  record: WorkRecordV1,
  snapshot: RepairStateSnapshotV1,
  overrides: Partial<PreReservationLiveFactsV1> = {},
): Promise<PreReservationLiveFactsV1> {
  const attempt = record.counters.attempts + 1;
  const purpose = record.counters.attempts === 0
    ? "implementation" as const
    : "retry" as const;
  const reservationId = await deriveReservationId({
    repository: record.repository,
    taskId: record.id,
    head: record.target.base,
    attempt,
    purpose,
  });
  const now = T0 + 5_000;
  const attempted = startAttempt(record, now);
  const intent = implementationIntent(reservationId, attempted, now);
  return {
    issue: { number: 1, title: "t", body: "b" },
    candidateRef: intent.branch,
    admission: {
      reservationId,
      attempt,
      purpose,
      nextWork: setIntent(attempted, intent, now),
      now,
      snapshot,
    },
    ...overrides,
  };
}

function policy(
  overrides: Partial<RepositoryConfigV1> = {},
): RepositoryConfigV1 {
  return { ...repairConfigs({ sessionBound: BOUND })[0]!, ...overrides };
}

Deno.test("pre-checks: a passing record is ok", async () => {
  const record = workRecord("issue-ok");
  const snapshot = seededSnapshot([record]);
  assert.deepEqual(
    preReservationChecks(record, policy(), await facts(record, snapshot)),
    { ok: true },
  );
});

Deno.test("pre-checks: each deterministic check refuses with its precise reason code", async () => {
  const record = workRecord("issue-pre");
  const snapshot = seededSnapshot([record]);
  const base = await facts(record, snapshot);
  const cases: {
    name: string;
    record?: WorkRecordV1;
    policy?: RepositoryConfigV1;
    facts: PreReservationLiveFactsV1;
    check: string;
    refused: string;
  }[] = [
    {
      name: "repository identity",
      record: { ...record, repository: { ...record.repository, owner: "" } },
      facts: base,
      check: "repository_identity",
      refused: "repository_identity_invalid",
    },
    {
      name: "task id",
      record: { ...record, id: "bad id" as never },
      facts: base,
      check: "task_identity",
      refused: "task_id_invalid",
    },
    {
      name: "base revision",
      record: {
        ...record,
        target: { ...record.target, base: "main" as never },
      },
      facts: base,
      check: "base_revision",
      refused: "base_not_commit_sha",
    },
    {
      name: "source freshness",
      facts: { ...base, latestBase: SHA2 },
      check: "source_freshness",
      refused: "base_stale",
    },
    {
      name: "opt-out marker",
      facts: {
        ...base,
        issue: { number: 1, title: "t", body: "<!-- sentinel:skip -->\nx" },
      },
      check: "opt_out_marker",
      refused: "sentinel_skip_marker",
    },
    {
      name: "candidate ref naming",
      facts: { ...base, candidateRef: "sentinel/repair/a..b" },
      check: "candidate_ref",
      refused: "candidate_ref_invalid",
    },
    {
      name: "candidate ref absent",
      facts: { ...base, candidateRef: null },
      check: "candidate_ref",
      refused: "candidate_ref_absent",
    },
    {
      name: "protected-path denylist",
      policy: policy({ protectedPaths: ["../escape"] }),
      facts: base,
      check: "protected_paths",
      refused: "protected_paths_malformed",
    },
    {
      name: "output bounds",
      policy: policy({
        sessionBound: { maxDurationMs: 1, maxOutputChars: 0 },
      }),
      facts: base,
      check: "output_bounds",
      refused: "session_bound_invalid",
    },
    {
      name: "logical identity collision",
      facts: {
        ...base,
        admission: {
          ...base.admission,
          snapshot: seededSnapshot([record], {
            reservations: [
              reservation("f".repeat(64), { taskId: record.id }),
            ],
          }),
        },
      },
      check: "attempt_identity",
      refused: "logical_identity_collision",
    },
    {
      name: "reservation id collision",
      facts: {
        ...base,
        admission: {
          ...base.admission,
          snapshot: seededSnapshot([record], {
            reservations: [
              reservation(base.admission.reservationId, { attempt: 7 }),
            ],
          }),
        },
      },
      check: "attempt_identity",
      refused: "reservation_id_collision",
    },
    {
      name: "admission transition",
      facts: {
        ...base,
        admission: {
          ...base.admission,
          nextWork: {
            ...base.admission.nextWork,
            counters: { ...base.admission.nextWork.counters, retries: 3 },
          },
        },
      },
      check: "admission_transition",
      refused: "transition_not_admissible",
    },
  ];
  for (const entry of cases) {
    assert.deepEqual(
      preReservationChecks(
        entry.record ?? record,
        entry.policy ?? policy(),
        entry.facts,
      ),
      { ok: false, check: entry.check, refused: entry.refused },
      entry.name,
    );
  }
});

Deno.test("pre-checks: an exact duplicate is left to the budget's own duplicate refusal", async () => {
  const record = workRecord("issue-dup");
  const base = await facts(record, seededSnapshot([record]));
  const duplicate = reservation(base.admission.reservationId, {
    taskId: record.id,
  });
  const result = preReservationChecks(record, policy(), {
    ...base,
    admission: {
      ...base.admission,
      snapshot: seededSnapshot([record], { reservations: [duplicate] }),
    },
  });
  assert.deepEqual(result, { ok: true });
});

Deno.test("branch names follow git's ref-format rules", () => {
  assert.ok(isValidBranchName(candidateBranch("issue-1" as never)));
  for (
    const bad of [
      "",
      "@",
      "a..b",
      "a/.hidden",
      "a.lock",
      "a/",
      "a.",
      "a//b",
      "a b",
      "a~b",
      "a@{b",
      "a\x01b",
    ]
  ) assert.equal(isValidBranchName(bad), false, bad);
});

Deno.test("post-inference preservation refusals name the check that needed the candidate", () => {
  assert.equal(
    preservationRefusalMessage(PUBLICATION_PROTECTED_DETAIL),
    "candidate preservation validation refused: protected_entry",
  );
  assert.equal(
    preservationRefusalMessage(PUBLICATION_FILE_BOUND_DETAIL),
    "candidate preservation validation refused: file_size_bound",
  );
  assert.equal(
    preservationRefusalMessage("something new"),
    "candidate preservation validation refused: unclassified",
  );
  assert.ok(
    isPreservationRefusalMessage("candidate preservation validation refused"),
  );
  assert.ok(
    isPreservationRefusalMessage(
      preservationRefusalMessage(PUBLICATION_PROTECTED_DETAIL),
    ),
  );
  assert.equal(
    isPreservationRefusalMessage(
      "candidate preservation validation refusedX",
    ),
    false,
  );
});

// ------------------------------------------------- real admission consumer

function rig(record: WorkRecordV1, extra: Partial<RepairStateSnapshotV1> = {}) {
  const state = new MemoryState();
  state.repair = seededSnapshot([record], extra);
  state.repairHead = SHA1;
  const clock = new FakeClock(T0);
  const configs = repairConfigs({ sessionBound: BOUND });
  const budget = new RollingStartBudget({ clock, state, configs });
  let reserveCalls = 0;
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github: new FakeGithub(),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    model: new FakeModel(),
    budget: {
      reserveModelStart: (request) => {
        reserveCalls++;
        return budget.reserveModelStart(request);
      },
      settleModelStart: (request) => budget.settleModelStart(request),
    },
  };
  const context: LoopContextV1 = {
    snapshot: state.repair,
    head: SHA1,
    executionBaseline: record,
    bounds: {
      runDeadline: clock.now() + 60 * 60_000,
      modelCutoff: clock.now() + 60 * 60_000,
    },
  };
  return {
    deps,
    context,
    configs,
    state,
    reserveCalls: () => reserveCalls,
  };
}

async function afterSnapshot(state: MemoryState) {
  const after = await state.readRepair();
  assert.ok(after.ok && after.value.status === "found");
  return after.value.snapshot;
}

Deno.test("admission: a pre-check refusal is never reserved and records its precise reason", async () => {
  const record = workRecord("issue-denylist");
  const r = rig(record);
  const before = canonicalStringify({
    live: r.state.repair!.reservations,
    archive: r.state.repair!.reservationArchive ?? [],
  });
  const config = { ...r.configs[0]!, protectedPaths: ["../escape"] };
  const result = await prepareImplementationStart(
    r.deps,
    r.context,
    record,
    config,
  );
  assert.equal(result.kind, "progress", JSON.stringify(result));
  assert.equal(r.reserveCalls(), 0, "the budget is never asked");
  const snapshot = await afterSnapshot(r.state);
  assert.equal(
    canonicalStringify({
      live: snapshot.reservations,
      archive: snapshot.reservationArchive ?? [],
    }),
    before,
    "the reservation store is unchanged",
  );
  const stored = snapshot.work.find((row) => row.id === record.id)!;
  assert.equal(stored.nextStep, "blocked");
  assert.equal(
    stored.blocker?.message,
    `${PRE_RESERVATION_REFUSED_PREFIX} protected_paths: protected_paths_malformed`,
  );
  assert.deepEqual(stored.counters, record.counters, "nothing counted");
  assert.equal(stored.intent, null);
});

Deno.test("admission: a logical-identity collision is refused before the reservation", async () => {
  const record = workRecord("issue-collide");
  const r = rig(record, {
    reservations: [reservation("e".repeat(64), { taskId: record.id })],
  });
  const before = canonicalStringify(r.state.repair!.reservations);
  const result = await prepareImplementationStart(
    r.deps,
    r.context,
    record,
    r.configs[0]!,
  );
  assert.equal(result.kind, "progress", JSON.stringify(result));
  assert.equal(r.reserveCalls(), 0);
  const snapshot = await afterSnapshot(r.state);
  assert.equal(canonicalStringify(snapshot.reservations), before);
  assert.equal(
    snapshot.work.find((row) => row.id === record.id)?.blocker?.message,
    `${PRE_RESERVATION_REFUSED_PREFIX} attempt_identity: logical_identity_collision`,
  );
});

Deno.test("admission: a passing record proceeds to the reservation as before", async () => {
  const record = workRecord("issue-pass");
  const r = rig(record);
  const result = await prepareImplementationStart(
    r.deps,
    r.context,
    record,
    r.configs[0]!,
  );
  assert.equal(result.kind, "prepared", JSON.stringify(result));
  assert.equal(r.reserveCalls(), 1);
  const snapshot = await afterSnapshot(r.state);
  assert.equal(snapshot.reservations.length, 1);
  assert.equal(snapshot.reservations[0]!.taskId, record.id);
  assert.equal(snapshot.reservations[0]!.outcome, "reserved");
});

Deno.test("the census refusal list is exactly the refusals the source can return", async () => {
  const source = await Deno.readTextFile(
    new URL("../../src/repair/pre-reservation-checks.ts", import.meta.url),
  );
  const written = [
    ...source.matchAll(/refuse\("([a-z_]+)", "([a-z_]+)"\)/g),
  ].map((match) => `${match[1]}:${match[2]}`).sort();
  assert.deepEqual(
    PRE_RESERVATION_REFUSALS.map((r) => `${r.check}:${r.refused}`).sort(),
    written,
  );
  assert.ok(POST_INFERENCE_CHECK_NAMES.includes("protected_entry"));
  assert.ok(POST_INFERENCE_CHECK_NAMES.includes("unclassified"));
  assert.equal(
    new Set(POST_INFERENCE_CHECK_NAMES).size,
    POST_INFERENCE_CHECK_NAMES.length,
  );
});
