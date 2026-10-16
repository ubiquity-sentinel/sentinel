/**
 * Five ai.ubq.fi records (587, 608, 764, 785, 905) were parked by the
 * historical runtime-mismatch isolation with their candidates' preservation
 * pending. Their producers admitted those candidates before ai.ubq.fi had its
 * own protected paths, so the launcher's trusted preserver now refuses each
 * one deterministically: the candidate edits an owner-protected path. The
 * shared restore tail turned that verdict into a silent `false`, so the walk
 * wrote nothing and logged nothing, and the record stayed parked until its
 * producer's plan artifact expired.
 *
 * These tests replay the live 587 and 608 records, with their live charges,
 * byte for byte. For the parked runtime-mismatch restore, with the record's
 * deterministic preservation ref proven absent, the tail now writes the
 * runtime's own terminal block for a candidate that touches a protected path
 * (loop-implementation-result.ts): the intent is cleared and the record is
 * blocked on "candidate touches a protected path", which no retry rule and no
 * preservation disposition class re-admits, so the owner handles it. Any
 * other deterministic verdict is the runtime's own refusal transition
 * (loop-preservation.ts), owned by the existing REFUSED disposition. The
 * target, head and descriptor stay as they are, and every charge stays
 * byte-identical. Every other preserver answer, a preservation ref that is
 * present or unreadable, and the same verdict for the in-flight and
 * existing-ref callers still write nothing, and nothing is retired by age.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  type GitHubPort,
  portError,
  type PortErrorKindV1,
  portOk,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  PUBLICATION_INPUT_DETAIL,
  PUBLICATION_PROTECTED_DETAIL,
  PUBLICATION_SECRET_DETAIL,
} from "../../src/github/snapshot-policy.ts";
import { STATIC_PRESERVE_INPUT } from "../../src/host/actions-candidates-shared.ts";
import { OWNER_DEVELOPMENT_INSTALL_GEN79_REVISION } from "../../src/host/owner-install-runtime-pins.ts";
import { blockedCandidateBinding } from "../../src/host/matrix-blocked-candidate.ts";
import {
  CANDIDATE_PROTECTED_BLOCKER,
  preserveBlockedCandidate,
} from "../../ops/hosted-autonomy-blocked-candidate.ts";
import { restoreExistingCandidateRefs } from "../../ops/hosted-autonomy-existing-candidate.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import { planHostedRetries } from "../../ops/hosted-autonomy-retries.ts";
import {
  PRESERVATION_REFUSED_BLOCKER,
  PRESERVATION_VALIDATION_REFUSED,
} from "../../ops/hosted-autonomy-preservation-disposition.ts";
import type {
  HostedAutonomyDepsV1,
  HostedClosedMatrixDepsV1,
} from "../../ops/hosted-autonomy-types.ts";
import {
  assertGen78Parses,
  assertGen79Parses,
  GEN79_RUNTIME,
} from "../state/gen77-contracts.ts";
import {
  gen78Available,
  gen79Available,
  loadGen78Modules,
  loadGen79Modules,
} from "./gen77-runtime-source.ts";
import { modernRecoveryScenario } from "./hosted-autonomy-modern-scenario.ts";
import { DAY, runAt, TIP } from "./hosted-autonomy-preservation-cases.ts";
import {
  snapshotOf,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";

const ignoreRollback = !await gen78Available() || !await gen79Available();

/** The live 587 and 608 records and all six of their charges, verbatim. */
const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../fixtures/host/parked-protected-refusal-v1.json",
      import.meta.url,
    ),
  ),
) as { work: WorkRecordV1[]; reservations: unknown[] };

/** The live pass time: after the 08:05Z pass, before the plan expiry. */
const NOW = Date.parse("2026-10-16T21:00:00Z");

function liveState(): TransitionState {
  const state = new TransitionState(
    snapshotOf(structuredClone(LIVE.work), structuredClone(LIVE.reservations)),
  );
  state.snapshot = { ...state.snapshot, updatedAt: NOW - 60_000 };
  return state;
}

/** Records every applied write as the exact (prior, next) pair. */
function recordWrites(state: TransitionState) {
  const writes: {
    prior: RepairStateSnapshotV1;
    next: RepairStateSnapshotV1;
  }[] = [];
  const write = state.writeRepair.bind(state);
  state.writeRepair = async (next, head) => {
    const prior = structuredClone(state.snapshot);
    const written = await write(next, head);
    if (written.ok && written.value.status === "applied") {
      writes.push({ prior, next: structuredClone(state.snapshot) });
    }
    return written;
  };
  return writes;
}

interface PreserverCall {
  taskId: string;
  candidate: unknown;
  publishedHead: unknown;
}

/**
 * The trusted preserver's answer, plus what the exact preservation ref reads
 * as afterwards (absent by default, a head, or an unreadable answer).
 */
function preserver(
  answer: ReturnType<typeof portError> | ReturnType<typeof portOk<void>>,
  ref: GitSha | null | ReturnType<typeof portError> = null,
) {
  const calls: PreserverCall[] = [];
  const reads: string[] = [];
  const github = {
    preserveCandidate: (request: PreserverCall) => {
      calls.push(structuredClone(request));
      return Promise.resolve(answer);
    },
    readRef: (name: string) => {
      reads.push(name);
      return Promise.resolve(
        ref === null
          ? portOk(null)
          : typeof ref === "string"
          ? portOk({ sha: ref })
          : ref,
      );
    },
  } as unknown as GitHubPort;
  return { github, calls, reads };
}

/** The launcher preserver's verdict on a candidate editing a protected path. */
const PROTECTED = portError("invalid", PUBLICATION_PROTECTED_DETAIL);

/** Another deterministic verdict on the same immutable candidate. */
const SECRET = portError("invalid", PUBLICATION_SECRET_DETAIL);

/** The literal both R78 and R79 block a protected-path candidate on. */
const RUNTIME_PROTECTED = "candidate touches a protected path";

/**
 * The shared tail exactly as the parked runtime-mismatch restore calls it
 * (`recordRefusal`), or as every other caller does (`shared`).
 */
function restore(
  state: TransitionState,
  record: WorkRecordV1,
  github: GitHubPort,
  now = NOW,
  shared = false,
) {
  const input = {
    record,
    state,
    github,
    clock: { now: () => now },
    readbackFailure: () => new Error("readback changed"),
    ...(shared ? {} : { recordRefusal: true as const }),
  };
  return preserveBlockedCandidate(input);
}

/**
 * The runtime's block on one record: the refusal transition
 * (loop-preservation.ts) or the protected-path block
 * (loop-implementation-result.ts).
 */
function blockedShape(
  record: WorkRecordV1,
  at: number,
  message: string,
): WorkRecordV1 {
  return {
    ...record,
    nextStep: "blocked",
    blocker: { kind: "other", message, since: at },
    wait: null,
    intent: null,
    updatedAt: at,
  };
}

/** Every field but the work rows and the write's own sequence fields. */
function unchangedRest(
  after: RepairStateSnapshotV1,
  before: RepairStateSnapshotV1,
) {
  const { work: _w, sequence: _s, updatedAt: _u, stateHead: _h, ...rest } =
    after;
  const {
    work: _bw,
    sequence: _bs,
    updatedAt: _bu,
    stateHead: _bh,
    ...beforeRest
  } = before;
  assert.deepEqual(rest, beforeRest);
}

/** Writes each live record's verdict in one walk, as producer 37996641586. */
async function settleLive(
  state: TransitionState,
  answer: ReturnType<typeof portError>,
  expected: "protected" | "refused",
  message: string,
  at = NOW,
) {
  for (const [index, live] of LIVE.work.entries()) {
    const record = state.snapshot.work.find((row) => row.id === live.id)!;
    const { github, calls, reads } = preserver(answer);
    assert.equal(await restore(state, record, github, at + index), expected);
    // The exact descriptor was offered to the trusted preserver, once, and
    // only then was its deterministic ref proven absent, once.
    assert.deepEqual(calls, [{
      taskId: live.id,
      candidate: {
        operationKey: live.intent!.key,
        base: live.target.base,
        head: live.target.head,
        ref: live.intent!.branch,
      },
      publishedHead: null,
    }]);
    assert.deepEqual(reads, [live.intent!.branch]);
    const written = state.snapshot.work.find((row) => row.id === live.id)!;
    assert.deepEqual(written, blockedShape(live, at + index, message));
    // Target, head, branch and the unpreserved descriptor are kept as is.
    assert.deepEqual(written.target, live.target);
  }
}

Deno.test("preservation refused: the live 587 and 608 fixtures are the parked runtime-mismatch shape their producer requests", () => {
  assert.equal(LIVE.work.length, 2);
  for (const record of LIVE.work) {
    const binding = blockedCandidateBinding(record);
    assert(binding !== null, record.id);
    assert.equal(binding.runId, 37996641586);
    assert.equal(binding.artifactId, 11648843445);
    assert.equal(record.intent?.kind, "candidate_preservation");
    assert.equal(record.target.candidateState?.preserved, null);
    const charge = (LIVE.reservations as { id: string; outcome: string }[])
      .find((row) => row.id === record.intent?.requestId);
    assert.equal(charge?.outcome, "submitted");
  }
});

Deno.test("preservation refused: the live 587 and 608 records settle into the runtime's protected-path block, charges byte-identical", async () => {
  assert.equal(CANDIDATE_PROTECTED_BLOCKER, RUNTIME_PROTECTED);
  const state = liveState();
  const before = structuredClone(state.snapshot);
  const writes = recordWrites(state);
  // The walk restores both cells of producer 37996641586 in one pass.
  await settleLive(state, PROTECTED, "protected", RUNTIME_PROTECTED);
  assert.equal(writes.length, 2);
  assert.equal(
    canonicalStringify(state.snapshot.reservations),
    canonicalStringify(before.reservations),
  );
  unchangedRest(state.snapshot, before);
  // A blocked record is no longer restorable: a second visit writes nothing.
  for (const live of LIVE.work) {
    const record = state.snapshot.work.find((row) => row.id === live.id)!;
    assert.equal(blockedCandidateBinding(record), null);
    const { github, calls } = preserver(PROTECTED);
    assert(!await restore(state, record, github, NOW + 10));
    assert.deepEqual(calls, []);
  }
  assert.equal(writes.length, 2);
});

Deno.test("preservation refused: any other deterministic verdict settles into the runtime's refused class, charges byte-identical", async () => {
  const state = liveState();
  const before = structuredClone(state.snapshot);
  const writes = recordWrites(state);
  await settleLive(state, SECRET, "refused", PRESERVATION_VALIDATION_REFUSED);
  assert.equal(writes.length, 2);
  assert.equal(
    canonicalStringify(state.snapshot.reservations),
    canonicalStringify(before.reservations),
  );
  unchangedRest(state.snapshot, before);
});

/** R78 and R79: the snapshot parsers, transition rules and own transitions. */
async function rollbackRuntimes() {
  const paths = [
    "src/state/state-repair-transition.ts",
    "src/repair/transitions.ts",
  ];
  const r78 = await loadGen78Modules(paths);
  const r79 = await loadGen79Modules([
    ...paths,
    "src/repair/conflict-resolution.ts",
  ]);
  return {
    // deno-lint-ignore no-explicit-any
    runtimes: [["R78", r78.modules], ["R79", r79.modules]] as [string, any[]][],
    // R79's own constant names the protected-path block the launcher writes.
    r79Protected: (r79.modules[2] as { CONFLICT_PROTECTED_DETAIL: string })
      .CONFLICT_PROTECTED_DETAIL,
    dispose: () => Promise.all([r78.dispose(), r79.dispose()]),
    /** Each write parses and validates under both runtimes. */
    async validate(
      writes: { prior: RepairStateSnapshotV1; next: RepairStateSnapshotV1 }[],
    ) {
      for (const { prior, next } of writes) {
        await assertGen78Parses(next);
        await assertGen79Parses(next);
        for (const [name, [transition]] of this.runtimes) {
          assert.equal(
            transition.validateRepairTransition(prior, next),
            null,
            name,
          );
        }
      }
    },
  };
}

Deno.test({
  name:
    "preservation refused: R78 and R79 accept the protected-path block, and neither the REFUSED disposition nor the retry pass ever re-admits it",
  ignore: ignoreRollback,
  fn: async () => {
    assert.equal(GEN79_RUNTIME, OWNER_DEVELOPMENT_INSTALL_GEN79_REVISION);
    const loaded = await rollbackRuntimes();
    try {
      assert.equal(loaded.r79Protected, CANDIDATE_PROTECTED_BLOCKER);
      const state = liveState();
      const writes = recordWrites(state);
      await settleLive(state, PROTECTED, "protected", RUNTIME_PROTECTED);
      for (const [index, live] of LIVE.work.entries()) {
        const at = NOW + index;
        // Each runtime's own transitions build the byte-identical record.
        for (const [name, [, transitions]] of loaded.runtimes) {
          const own = transitions.markBlocked(
            transitions.clearIntent(live, at),
            "other",
            RUNTIME_PROTECTED,
            at,
          );
          assert.equal(
            canonicalStringify(
              state.snapshot.work.find((row) => row.id === live.id),
            ),
            canonicalStringify(own),
            name,
          );
        }
      }
      assert.equal(writes.length, 2);
      await loaded.validate(writes);
      // A day, nine days and ninety days later, with the base advanced past
      // the candidate's base, no pass re-admits it or retires it by age: the
      // REFUSED class never judges it and no retry rule matches it.
      const blocked = canonicalStringify(state.snapshot);
      for (const at of [NOW + DAY, NOW + 9 * DAY, NOW + 90 * DAY]) {
        const result = await runAt(state, {}, at);
        assert.equal(writes.length, 2, JSON.stringify(result));
        assert.equal(canonicalStringify(state.snapshot), blocked);
        // The retry planner itself plans neither at the advanced base.
        const plans = planHostedRetries(
          state.snapshot,
          at,
          GEN79_RUNTIME as GitSha,
          new Map([[hostedRepositoryKey(LIVE.work[0]!.repository), TIP]]),
        );
        for (const live of LIVE.work) {
          assert(
            !result.actions.some((action) => action.includes(live.id)),
            JSON.stringify(result),
          );
          assert(!plans.some((plan) => plan.id === live.id), live.id);
        }
      }
    } finally {
      await loaded.dispose();
    }
  },
});

Deno.test({
  name:
    "preservation refused: R78 and R79 accept any other refusal, and its disposition and retry writes, while the REFUSED class owns it",
  ignore: ignoreRollback,
  fn: async () => {
    const loaded = await rollbackRuntimes();
    try {
      const state = liveState();
      const writes = recordWrites(state);
      await settleLive(
        state,
        SECRET,
        "refused",
        PRESERVATION_VALIDATION_REFUSED,
      );
      for (const [index, live] of LIVE.work.entries()) {
        const at = NOW + index;
        for (const [name, [, transitions]] of loaded.runtimes) {
          const own = transitions.markBlocked(
            transitions.clearIntent(live, at),
            "other",
            "candidate preservation validation refused",
            at,
          );
          assert.equal(
            canonicalStringify(
              state.snapshot.work.find((row) => row.id === live.id),
            ),
            canonicalStringify(own),
            name,
          );
        }
      }
      // Too early for the disposition: nothing is retired by age alone.
      const early = await runAt(state, {}, NOW + DAY - 1);
      assert.equal(writes.length, 2, JSON.stringify(early));
      for (const live of LIVE.work) {
        assert(
          early.actions.includes(`preservation:${live.id}:retained:pacing`),
          JSON.stringify(early),
        );
      }
      // A day later with the base advanced, the existing REFUSED class hands
      // both to the retry authority, every charge untouched.
      const charges = canonicalStringify(state.snapshot.reservations);
      const disposed = await runAt(state, {}, NOW + DAY + 1);
      assert.equal(disposed.reason, "dispositioned", JSON.stringify(disposed));
      for (const live of LIVE.work) {
        assert(
          disposed.actions.includes(
            `preservation:${live.id}:unrecoverable:refused`,
          ),
          JSON.stringify(disposed),
        );
        const row = state.snapshot.work.find((item) => item.id === live.id)!;
        assert.equal(row.blocker?.message, PRESERVATION_REFUSED_BLOCKER);
      }
      assert.equal(canonicalStringify(state.snapshot.reservations), charges);
      // The same planner check the protected block fails plans this class.
      assert(
        planHostedRetries(
          state.snapshot,
          NOW + DAY + 1000,
          GEN79_RUNTIME as GitSha,
          new Map([[hostedRepositoryKey(LIVE.work[0]!.repository), TIP]]),
        ).some((plan) => LIVE.work.some((live) => live.id === plan.id)),
      );
      const retried = await runAt(state, {}, NOW + DAY + 1000);
      assert.equal(retried.reason, "retried", JSON.stringify(retried));
      assert(
        state.snapshot.work.some((row) => row.nextStep === "work"),
        JSON.stringify(state.snapshot.work.map((row) => row.nextStep)),
      );
      assert.equal(canonicalStringify(state.snapshot.reservations), charges);
      assert(writes.length >= 4, String(writes.length));
      await loaded.validate(writes);
    } finally {
      await loaded.dispose();
    }
  },
});

Deno.test("preservation refused: a deterministic preservation ref that is present or unreadable keeps custody", async () => {
  const live = LIVE.work[0]!;
  const refs: [string, GitSha | ReturnType<typeof portError>][] = [
    ["the exact candidate already at its ref", live.target.head as GitSha],
    ["another head at its ref", "9".repeat(40) as GitSha],
    ["an unreadable ref", portError("unavailable", "ref read failed")],
    ["an invalid ref answer", portError("invalid", "malformed")],
  ];
  for (const answer of [PROTECTED, SECRET]) {
    for (const [name, ref] of refs) {
      const state = liveState();
      const before = canonicalStringify(state.snapshot);
      const { github, calls, reads } = preserver(answer, ref);
      assert.equal(await restore(state, live, github), null, name);
      assert.equal(calls.length, 1, name);
      assert.deepEqual(reads, [live.intent!.branch], name);
      assert.equal(state.writes, 0, name);
      assert.equal(canonicalStringify(state.snapshot), before, name);
    }
  }
});

Deno.test("preservation refused: every answer short of the validator's verdict on the exact ref writes nothing", async () => {
  const live = LIVE.work[0]!;
  const cases: [string, WorkRecordV1, ReturnType<typeof portError>][] = [
    ...(["unavailable", "not_found", "conflict", "rate_limited"] as const).map(
      (kind) =>
        [
          `${kind} with the protected detail`,
          live,
          portError(kind as PortErrorKindV1, PUBLICATION_PROTECTED_DETAIL),
        ] as [string, WorkRecordV1, ReturnType<typeof portError>],
    ),
    [
      "invalid request shape",
      live,
      portError("invalid", STATIC_PRESERVE_INPUT),
    ],
    [
      "invalid without a publication verdict",
      live,
      portError("invalid", PUBLICATION_INPUT_DETAIL),
    ],
    [
      "the verdict on a ref other than the deterministic one",
      {
        ...live,
        intent: {
          ...live.intent!,
          branch: "refs/heads/sentinel-candidates/" + "0".repeat(64),
        },
      },
      PROTECTED,
    ],
  ];
  for (
    const [name, record, answer, shared] of [
      ...cases.map(([name, record, answer]) =>
        [name, record, answer, false] as const
      ),
      // The in-flight and existing-ref callers keep custody on the verdict.
      [
        "the verdict for a caller that keeps custody",
        live,
        PROTECTED,
        true,
      ] as const,
    ]
  ) {
    const state = new TransitionState(
      snapshotOf(
        LIVE.work.map((row) => row.id === record.id ? record : row),
        structuredClone(LIVE.reservations),
      ),
    );
    state.snapshot = { ...state.snapshot, updatedAt: NOW - 60_000 };
    const before = canonicalStringify(state.snapshot);
    const { github, calls } = preserver(answer);
    // Nothing proven: no outcome (the tail's `null`; `false` before).
    assert(!await restore(state, record, github, NOW, shared), name);
    assert.equal(calls.length, 1, name);
    assert.equal(state.writes, 0, name);
    assert.equal(canonicalStringify(state.snapshot), before, name);
  }
});

Deno.test("preservation refused: a changed record, a moved clock or a lost CAS writes nothing", async () => {
  const live = LIVE.work[0]!;
  // The record in state no longer matches the one the walk read.
  {
    const state = liveState();
    const stale = { ...live, updatedAt: live.updatedAt - 1 };
    const { github, calls } = preserver(PROTECTED);
    assert(!await restore(state, stale, github));
    assert.deepEqual(calls, []);
    assert.equal(state.writes, 0);
  }
  // A clock behind the snapshot.
  {
    const state = liveState();
    const before = canonicalStringify(state.snapshot);
    const { github } = preserver(PROTECTED);
    assert(!await restore(state, live, github, state.snapshot.updatedAt - 1));
    assert.equal(state.writes, 0);
    assert.equal(canonicalStringify(state.snapshot), before);
  }
  // Custody moved between the preserver's verdict and the write.
  {
    const state = liveState();
    const before = canonicalStringify(state.snapshot);
    const { github } = preserver(PROTECTED);
    const refuse = github.preserveCandidate;
    github.preserveCandidate = async (request) => {
      const answer = await refuse(request);
      state.head = "9".repeat(40) as GitSha;
      return answer;
    };
    assert(!await restore(state, live, github));
    assert.equal(state.writes, 0);
    assert.equal(canonicalStringify(state.snapshot), before);
  }
  // An expected-head CAS lost to a concurrent writer.
  {
    const state = liveState();
    const before = canonicalStringify(state.snapshot);
    state.writeRepair = () =>
      Promise.resolve(
        portOk({ status: "conflict" as const, currentHead: state.head }),
      );
    assert(!await restore(state, live, preserver(PROTECTED).github));
    assert.equal(canonicalStringify(state.snapshot), before);
  }
});

Deno.test("preservation refused: without the producer's verdict the parked records are never retired by age", async () => {
  const state = liveState();
  const before = canonicalStringify(state.snapshot);
  for (const at of [NOW, NOW + 9 * DAY, NOW + 90 * DAY]) {
    const result = await runAt(state, {}, at);
    assert.equal(state.writes, 0, JSON.stringify(result));
    assert.equal(canonicalStringify(state.snapshot), before);
  }
});

Deno.test("preservation refused: the existing-ref pass keeps custody on the same verdict", async () => {
  const state = liveState();
  const before = canonicalStringify(state.snapshot);
  const live = LIVE.work[0]!;
  const actions: string[] = [];
  const { github, calls } = preserver(PROTECTED);
  const result = await restoreExistingCandidateRefs({
    deps: {
      state,
      clock: { now: () => NOW },
      githubFor: () => ({
        readBaseTip: (branch: string) =>
          Promise.resolve(
            "refs/heads/" + branch === live.intent!.branch
              ? live.target.head
              : null,
          ),
      }),
    } as unknown as HostedAutonomyDepsV1,
    ports: {
      configs: [{ repository: live.repository }],
      prepareTarget: () => Promise.resolve(),
      cycleFor: () => ({ github }),
    } as unknown as HostedClosedMatrixDepsV1,
    dedicated: new Set(),
    actions,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(actions, [`existing-ref:${live.id}:unproven`]);
  assert.equal(result, null);
  assert.equal(state.writes, 0);
  assert.equal(canonicalStringify(state.snapshot), before);
});

Deno.test("preservation refused: the real walk records the trusted preserver's protected-path verdict and reports it", () =>
  modernRecoveryScenario(true, false, "protected-refusal"));
