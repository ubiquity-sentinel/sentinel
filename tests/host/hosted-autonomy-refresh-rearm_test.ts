/**
 * An intact preserved candidate whose base refresh the generation-76 validator
 * refused (ai.ubq.fi issue 649, PR 1012) returns to its own delivery through
 * the real hosted maintenance pass once an allowlisted corrected runtime is
 * installed, only for a refusal written before that runtime's activation, and
 * only from its exact native publication. Nothing is charged or refunded.
 */
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  candidateBranch,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import {
  type HostedAutonomyGitHubV1,
  type HostedAutonomyPullV1,
  type HostedAutonomyResultV1,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import {
  HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES,
  refreshFixActivation,
} from "../../ops/hosted-autonomy-refresh-rearm.ts";
import type { HostedRefreshRearmRuntimeV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  parseReleaseStateSnapshotV1,
  type ReleaseStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { buildOwnerDevelopmentInstallSnapshot } from "../../src/host/owner-install-snapshot.ts";
import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import {
  releaseAt,
  settlementProof,
  snapshotOf,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";

const REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
};
const ID = "issue-ubiquity-ai.ubq.fi-649";
const BASE = SHA1;
const HEAD = SHA2;
const TIP = SHA3;
const DAY = 24 * 60 * 60 * 1000;
const BRANCH = candidateBranch(ID as never);
const REFUSAL =
  "base refresh failed 3 consecutive times: invalid candidate could not be preserved";
/** The runtime's owner-gated refresh park (`BASE_REFRESH_REFUSED_PREFIX`). */
const OWNER_PARK =
  "base refresh refused by trusted validation; owner action required (land the change by hand or close the issue): ";
/** The generation-76 runtime, without the base-edge validator fix. */
const R76 = "41bb853a1bedfc0422bf903dfabbe23bf714b44f";
/** A stand-in corrected runtime revision. */
const R77 = "7".repeat(40);
/** The instant of the launcher commit that pins R77: after the refusal. */
const PINNED = T0 + 3 * 60 * 60 * 1000;
const pin = (
  revision: string,
  activatedNotBefore = PINNED,
): HostedRefreshRearmRuntimeV1 => ({ revision, activatedNotBefore });

/**
 * R77 installed at generation 77 over generation 76, whose healthy proof was
 * observed an hour after the refusal: the refusal predates the activation.
 */
const FIXED = () =>
  releaseAt({
    revision: R77,
    generation: 77,
    healthy: {
      revision: R76,
      generation: 76,
      createdAt: T0 + 60 * 60 * 1000,
      observedAt: T0 + 2 * 60 * 60 * 1000,
    },
  });

async function refusedRefresh(message = REFUSAL): Promise<WorkRecordV1> {
  const operationKey = `base_refresh:1012:${"c".repeat(40)}:${BASE}`;
  return workRecord(ID, {
    repository: REPO,
    source: { kind: "issue", id: "649", revision: SHA1 },
    related: { incidentId: null, issueNumber: 649 },
    nextStep: "blocked",
    blocker: { kind: "other", message, since: T0 },
    counters: { attempts: 4, retries: 0, reviewRounds: 1 },
    target: {
      base: BASE,
      branch: BRANCH,
      candidateState: {
        preserved: {
          operationKey,
          base: BASE,
          head: HEAD,
          ref: await candidatePreservationRef(REPO, ID as never, operationKey),
        },
        publishedHead: HEAD,
      },
      checkpoint: null,
      head: HEAD,
      pr: null,
    },
  });
}

interface Facts {
  issueOpen?: boolean;
  branchTip?: string | null;
  preservedTip?: string | null;
  pulls?: { number: number; state: string; head: string | null }[] | null;
  pull?: Partial<HostedAutonomyPullV1> | null;
}

function surface(facts: Facts = {}): HostedAutonomyGitHubV1 {
  const pull: HostedAutonomyPullV1 = {
    number: 1012,
    state: "open",
    merged: false,
    mergeCommitSha: null,
    headSha: HEAD,
    baseRef: "development",
    baseSha: BASE,
    author: "ubiquity-sentinel[bot]",
    parents: [],
    revisionOnBaseBranch: false,
    baseAncestorOfRevision: false,
    ...(facts.pull ?? {}),
  };
  return {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: (branch: string) =>
      Promise.resolve(
        branch === "development"
          ? TIP
          : branch === BRANCH
          ? (facts.branchTip === undefined ? HEAD : facts.branchTip)
          : branch.startsWith("sentinel-candidates/")
          ? (facts.preservedTip === undefined ? HEAD : facts.preservedTip)
          : null,
      ),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(facts.pull === null ? null : pull),
    readIssueOpen: () => Promise.resolve(facts.issueOpen ?? true),
    merge: () => Promise.resolve(null),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    mismatchDisposition: {
      readRefAbsent: () => Promise.resolve(null),
      listPullsByHead: () =>
        Promise.resolve(
          facts.pulls === undefined
            ? [{ number: 1012, state: "open", head: BRANCH }]
            : facts.pulls,
        ),
      readRunTerminal: () => Promise.resolve(null),
    },
  };
}

async function runAt(
  state: TransitionState,
  facts: Facts,
  now: number,
  /** null runs the production allowlist. */
  runtimes: readonly HostedRefreshRearmRuntimeV1[] | null = [pin(R77)],
): Promise<HostedAutonomyResultV1> {
  return runHostedAutonomy(
    await withDarkQueueAuthority({
      state: state as unknown as StateReadView & RepairStateWriter,
      githubFor: () => surface(facts),
      clock: { now: () => now },
      ...(runtimes === null ? {} : { refreshRearmRuntimes: runtimes }),
    }),
  );
}

const CHARGE = reservation("d".repeat(64), {
  repository: REPO,
  taskId: ID,
  attempt: 4,
  head: BASE,
  purpose: "retry",
  outcome: "submitted",
  settledAt: T0 - 1,
  createdAt: T0 - 1000,
});

Deno.test("refresh re-arm: an allowlisted runtime returns a refusal that predates its activation to its exact delivery", async () => {
  const record = await refusedRefresh();
  const state = new TransitionState(snapshotOf([record], [CHARGE]), FIXED());
  const before = structuredClone(state.snapshot);
  const now = T0 + 2 * DAY;
  const result = await runAt(state, {}, now);
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert(result.actions.includes(`refresh:${ID}:rearmed:1012`));
  assert.equal(state.writes, 1);
  assert.deepEqual(state.snapshot.work[0], {
    ...record,
    nextStep: "delivery",
    blocker: null,
    wait: null,
    target: { ...record.target, pr: 1012 },
    updatedAt: now,
  });
  assert.deepEqual(state.snapshot.reservations, before.reservations);
});

for (
  const [name, facts, now, reason] of [
    ["a refusal inside the pacing window", {}, T0 + DAY / 2, "pacing"],
    [
      "a moved candidate branch",
      { branchTip: TIP },
      T0 + 2 * DAY,
      "branch",
    ],
    [
      "a missing preservation ref",
      { preservedTip: null },
      T0 + 2 * DAY,
      "preservation_ref",
    ],
    ["no open pull request", { pulls: [] }, T0 + 2 * DAY, "pull_listing"],
    [
      "two open pull requests",
      {
        pulls: [
          { number: 1012, state: "open", head: BRANCH },
          { number: 1013, state: "open", head: BRANCH },
        ],
      },
      T0 + 2 * DAY,
      "pull_listing",
    ],
    [
      "an unreadable pull listing",
      { pulls: null },
      T0 + 2 * DAY,
      "pull_listing",
    ],
    [
      "a pull request at another head",
      { pull: { headSha: TIP } },
      T0 + 2 * DAY,
      "pull",
    ],
    [
      "a foreign pull request author",
      { pull: { author: "someone" } },
      T0 + 2 * DAY,
      "pull",
    ],
    [
      "a merged pull request",
      { pull: { merged: true } },
      T0 + 2 * DAY,
      "pull",
    ],
    [
      "a pull request against another base branch",
      { pull: { baseRef: "main" } },
      T0 + 2 * DAY,
      "pull",
    ],
  ] as const
) {
  Deno.test(`refresh re-arm: ${name} keeps the record blocked`, async () => {
    const record = await refusedRefresh();
    const state = new TransitionState(snapshotOf([record], [CHARGE]), FIXED());
    const before = canonicalStringify(state.snapshot);
    const result = await runAt(state, facts as Facts, now);
    assert.equal(state.writes, 0, JSON.stringify(result));
    assert.equal(canonicalStringify(state.snapshot), before);
    assert(
      result.actions.includes(`refresh:${ID}:retained:${reason}`),
      JSON.stringify(result),
    );
  });
}

Deno.test("refresh re-arm: a closed issue's refused refresh is never re-armed while its pull request stays open", async () => {
  // Re-armed, the runtime would refresh, publish and request a charged review
  // for a closed issue; closure retires the record only once both are closed.
  const record = await refusedRefresh();
  const state = new TransitionState(snapshotOf([record], [CHARGE]), FIXED());
  const before = canonicalStringify(state.snapshot);
  const result = await runAt(state, { issueOpen: false }, T0 + 2 * DAY);
  assert.equal(state.writes, 0, JSON.stringify(result));
  assert.equal(canonicalStringify(state.snapshot), before);
  assert(!result.actions.some((action) => action.startsWith("refresh:")));
});

Deno.test("refresh re-arm: a record with no review round left stays blocked without a remote read (hard ceiling)", async () => {
  // Re-armed, the runtime would refresh onto the moved base and the refreshed
  // head would need a fourth review round (owner decision 2026-10-16).
  const record = await refusedRefresh();
  const charges = [1, 2, 3].map((attempt) =>
    reservation(`${"e".repeat(62)}0${attempt}`, {
      repository: REPO,
      taskId: ID,
      attempt,
      head: HEAD,
      purpose: "review_request",
      outcome: "submitted",
      settledAt: T0 - 1,
      createdAt: T0 - 1000,
    })
  );
  for (
    const [capped, rows] of [
      [{ ...record, counters: { ...record.counters, reviewRounds: 3 } }, []],
      [record, charges],
    ] as const
  ) {
    const state = new TransitionState(
      snapshotOf([capped], [CHARGE, ...rows]),
      FIXED(),
    );
    const before = canonicalStringify(state.snapshot);
    let listings = 0;
    const result = await runHostedAutonomy(
      await withDarkQueueAuthority({
        state: state as unknown as StateReadView & RepairStateWriter,
        githubFor: () => {
          const github = surface();
          const listing = github.mismatchDisposition!;
          return {
            ...github,
            mismatchDisposition: {
              ...listing,
              listPullsByHead: (branch: string) => {
                listings++;
                return listing.listPullsByHead(branch);
              },
            },
          };
        },
        clock: { now: () => T0 + 2 * DAY },
        refreshRearmRuntimes: [pin(R77)],
      }),
    );
    assert.equal(state.writes, 0, JSON.stringify(result));
    assert.equal(canonicalStringify(state.snapshot), before);
    assert(
      result.actions.includes(`refresh:${ID}:retained:review_rounds_spent`),
      JSON.stringify(result),
    );
    assert.equal(listings, 0, "no pull request is listed for it");
  }
});

Deno.test("refresh re-arm: transient refresh failures and other blockers are not this pass's", async () => {
  for (
    const message of [
      "base refresh failed 3 consecutive times: unavailable candidate could not be preserved",
      "base refresh has conflicts",
    ]
  ) {
    const record = await refusedRefresh(message);
    const state = new TransitionState(snapshotOf([record], [CHARGE]), FIXED());
    const result = await runAt(state, {}, T0 + 2 * DAY);
    assert.equal(state.writes, 0);
    assert(!result.actions.some((action) => action.startsWith("refresh:")));
  }
});

/** Runs the real maintenance at a day past pacing and expects one retention. */
async function expectRetained(
  record: WorkRecordV1,
  release: ReleaseStateSnapshotV1,
  reason: string,
  runtimes: readonly HostedRefreshRearmRuntimeV1[] | null = [pin(R77)],
): Promise<void> {
  const state = new TransitionState(snapshotOf([record], [CHARGE]), release);
  await expectStateRetained(state, reason, runtimes);
}

async function expectStateRetained(
  state: TransitionState,
  reason: string,
  runtimes: readonly HostedRefreshRearmRuntimeV1[] | null,
): Promise<void> {
  const before = canonicalStringify(state.snapshot);
  const result = await runAt(state, {}, T0 + 2 * DAY, runtimes);
  assert.equal(state.writes, 0, JSON.stringify(result));
  assert.equal(canonicalStringify(state.snapshot), before);
  assert(
    result.actions.includes(`refresh:${ID}:retained:${reason}`),
    JSON.stringify(result),
  );
}

/**
 * The corrected validator's own refusal (JAM B11): one CAS write parks it for
 * the owner with the verified PR restored, and the next pass only names it.
 */
async function expectParked(
  record: WorkRecordV1,
  release: ReleaseStateSnapshotV1,
  runtimes: readonly HostedRefreshRearmRuntimeV1[] | null = [pin(R77)],
  now = T0 + 2 * DAY,
): Promise<void> {
  const state = new TransitionState(snapshotOf([record], [CHARGE]), release);
  const charges = canonicalStringify(state.snapshot.reservations);
  const result = await runAt(state, {}, now, runtimes);
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert(
    result.actions.includes(`refresh:${ID}:owner_parked:pr=1012`),
    JSON.stringify(result),
  );
  assert.equal(state.writes, 1);
  assert.deepEqual(state.snapshot.work[0], {
    ...record,
    blocker: {
      kind: "other",
      message: `${OWNER_PARK}${record.blocker!.message}`,
      since: now,
    },
    target: { ...record.target, pr: 1012 },
    updatedAt: now,
  });
  assert.equal(canonicalStringify(state.snapshot.reservations), charges);
  const parked = canonicalStringify(state.snapshot);
  const later = await runAt(state, {}, now + DAY, runtimes);
  assert.equal(state.writes, 1, JSON.stringify(later));
  assert.equal(canonicalStringify(state.snapshot), parked);
  assert(
    later.actions.includes(`refresh:${ID}:owner_required:pr=1012`),
    JSON.stringify(later),
  );
}

Deno.test("refresh re-arm: a rollback that advanced the generation to 78 on generation-76 code keeps the record blocked", async () => {
  const record = await refusedRefresh();
  // A failed 77 restores 41bb853a1 once at generation 78: the generation
  // passed any numeric bound, the installed code is still uncorrected.
  const rollback = releaseAt({
    revision: R76,
    generation: 78,
    healthy: {
      revision: R77,
      generation: 77,
      createdAt: T0 + 60 * 60 * 1000,
      observedAt: T0 + 2 * 60 * 60 * 1000,
    },
  });
  await expectRetained(record, rollback, "runtime");
  await expectRetained(record, rollback, "runtime", []);
  await expectRetained(record, rollback, "runtime", null);
});

Deno.test("refresh re-arm: the shipped allowlist names only generations 77 through 81, so an unnamed corrected runtime never re-arms", async () => {
  assert.deepEqual(
    HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES.map((row) => row.revision),
    [
      "ab3613e0224ff92266bed21dde6f40e6b0aab54a",
      "474f87eb639f97cd72b9bc4b9e56101488f841aa",
      "549c7a69186b3d2070aa4e69c92ee846d183ce8f",
      "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481",
      "da98f5f49c45b57cfa97a45fe647c36b1021f302",
    ],
  );
  assert.equal(
    HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES.at(-1)?.activatedNotBefore,
    1792299493000,
  );
  for (const row of HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES) {
    assert.ok(Number.isSafeInteger(row.activatedNotBefore));
  }
  const record = await refusedRefresh();
  await expectRetained(record, FIXED(), "runtime", null);
  await expectRetained(record, FIXED(), "runtime", []);
});

Deno.test("refresh re-arm: a refusal written after the corrected runtime's activation is its own and parks for the owner", async () => {
  const record = await refusedRefresh();
  const after = releaseAt({
    revision: R77,
    generation: 77,
    healthy: {
      revision: R76,
      generation: 76,
      createdAt: T0 - 2 * 60 * 60 * 1000,
      observedAt: T0 - 60 * 60 * 1000,
    },
  });
  await expectParked(record, after);
  // A refusal exactly at the activation instant is not before it.
  const at = releaseAt({
    revision: R77,
    generation: 77,
    healthy: {
      revision: R76,
      generation: 76,
      createdAt: T0 - 60 * 60 * 1000,
      observedAt: T0,
    },
  });
  await expectParked(record, at);
});

/**
 * The supervisor workflow's real order: run N's maintenance sees generation 76
 * installed; its prepare installs R77 at 77 (the owner-install rung) and
 * starts R77's bootstrap; its finalize settles that bootstrap healthy, which
 * replaces both earlier-generation proofs. Every later maintenance sees only
 * R77's own proofs.
 */
function ownerInstalledAndBootstrapped(at: number): ReleaseStateSnapshotV1 {
  const g76 = releaseAt({
    revision: R76,
    generation: 76,
    healthy: {
      revision: R76,
      generation: 76,
      createdAt: at - 60 * 60 * 1000,
      observedAt: at - 30 * 60 * 1000,
    },
  });
  const installed = buildOwnerDevelopmentInstallSnapshot(
    g76,
    SHA3 as GitSha,
    {
      action: "install",
      priorRevision: R76 as GitSha,
      priorGeneration: 76,
      nextRevision: R77 as GitSha,
      nextGeneration: 77,
      priorHealthyProof: g76.hostedRuntimes[0]!.lastHealthyProof!,
    },
    at + 60_000,
    undefined,
    undefined,
    DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
    DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
  );
  const boot = settlementProof({
    revision: R77,
    generation: 77,
    createdAt: at + 120_000,
    observedAt: at + 30 * 60_000,
  });
  const bootstrap = {
    ...boot,
    execution: { ...boot.execution, purpose: "bootstrap" },
  };
  return parseReleaseStateSnapshotV1({
    ...installed,
    sequence: installed.sequence + 1,
    hostedRuntimes: [{
      ...installed.hostedRuntimes[0]!,
      execution: null,
      lastExecutionProof: bootstrap,
      lastHealthyProof: bootstrap,
      updatedAt: at + 30 * 60_000,
    }],
  });
}

Deno.test("refresh re-arm: a healthy owner install whose bootstrap settled in the install run re-arms a refusal before its pinned bound", async () => {
  // The launcher commit pins R77 at PINNED and installs it a day later.
  const installedAt = PINNED + DAY;
  const release = ownerInstalledAndBootstrapped(installedAt);
  assert.equal(release.hostedRuntimes[0]!.activeRevision, R77);
  assert.equal(
    release.hostedRuntimes[0]!.lastHealthyProof!.execution.generation,
    77,
    "the earlier generation's settlements are gone",
  );
  for (const now of [installedAt + 60 * 60 * 1000, installedAt + 30 * DAY]) {
    const record = await refusedRefresh();
    const state = new TransitionState(snapshotOf([record], [CHARGE]), release);
    const result = await runAt(state, {}, now);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert(result.actions.includes(`refresh:${ID}:rearmed:1012`));
    assert.equal(state.writes, 1);
    assert.equal(state.snapshot.work[0]!.nextStep, "delivery");
    assert.equal(state.snapshot.work[0]!.target.pr, 1012);
  }
});

Deno.test("refresh re-arm: after a healthy owner install, a refusal at or after the pinned bound is the corrected runtime's own and parks for the owner", async () => {
  const installedAt = PINNED + DAY;
  const release = ownerInstalledAndBootstrapped(installedAt);
  for (const since of [PINNED, installedAt + 60 * 60 * 1000]) {
    const record = await refusedRefresh();
    await expectParked(
      { ...record, blocker: { ...record.blocker!, since } },
      release,
      [pin(R77)],
      installedAt + 30 * DAY,
    );
  }
});

Deno.test("refresh re-arm: a pinned bound later than the runtime's own recorded execution never counts, so no re-arm is ever proven and the refusal parks for the owner", async () => {
  // R77 already executed before this pin: the pin is not its activation
  // bound, and with only its own proofs nothing else qualifies. With no
  // provable activation the refusal is never re-armed; it is named for the
  // owner instead of being retained forever.
  const record = await refusedRefresh();
  const release = ownerInstalledAndBootstrapped(T0 + DAY);
  await expectParked(record, release, [pin(R77, T0 + DAY + 10 * 60_000)]);
  await expectParked(
    record,
    releaseAt({
      revision: R77,
      generation: 77,
      healthy: {
        revision: R77,
        generation: 77,
        createdAt: T0 + 60 * 60 * 1000,
        observedAt: T0 + 2 * 60 * 60 * 1000,
      },
    }),
  );
});

Deno.test("refresh re-arm: a preserved descriptor bound to another base keeps the record blocked", async () => {
  const record = await refusedRefresh();
  const preserved = record.target.candidateState!.preserved!;
  const state = new TransitionState(snapshotOf([record], [CHARGE]), FIXED());
  // The record parser already refuses this custody; the pass keeps its own
  // binding, so a reader that skipped the parser still re-arms nothing.
  state.snapshot = {
    ...state.snapshot,
    work: [{
      ...record,
      target: {
        ...record.target,
        candidateState: {
          ...record.target.candidateState!,
          preserved: { ...preserved, base: TIP },
        },
      },
    }],
  };
  await expectStateRetained(state, "shape", [pin(R77)]);
});

Deno.test("refresh re-arm: activation reads only custody that never moves forward", () => {
  const fixed = FIXED();
  const runtime = fixed.hostedRuntimes[0]!;
  // An earlier generation's settlement of an uncorrected runtime: observed
  // before the pointer moved.
  assert.equal(
    refreshFixActivation(fixed, [pin(R77)]),
    T0 + 2 * 60 * 60 * 1000,
  );
  assert.equal(refreshFixActivation(fixed, []), null);
  assert.equal(refreshFixActivation(fixed, [pin(R76)]), null);
  // An earlier generation's settlement of a corrected runtime: the fix
  // already ran from that execution's creation.
  const corrected = settlementProof({
    revision: R77,
    generation: 75,
    createdAt: T0 - 5000,
    observedAt: T0 + 5000,
  });
  assert.equal(
    refreshFixActivation({
      ...fixed,
      hostedRuntimes: [{ ...runtime, lastExecutionProof: corrected as never }],
    }, [pin(R77)]),
    T0 - 5000,
  );
  // Every hosted release proof of an allowlisted runtime is immutable; the
  // earliest execution creation wins, other runtimes' proofs never count.
  const proof = (revision: string, createdAt: number) =>
    settlementProof({ revision, generation: 77, createdAt, observedAt: 0 });
  const released = {
    ...fixed,
    hostedReleases: [
      {
        priorProof: proof(R76, T0 - 9000),
        candidateProof: proof(R77, T0 + 1000),
        rollbackProof: null,
      },
      {
        priorProof: null,
        candidateProof: null,
        rollbackProof: proof(R77, T0 + 500),
      },
    ],
  } as unknown as ReleaseStateSnapshotV1;
  assert.equal(refreshFixActivation(released, [pin(R77)]), T0 + 500);
  // The installed generation's own settlements are replaced every run.
  const proven = {
    ...released,
    hostedRuntimes: [{
      ...runtime,
      lastHealthyProof: proof(R77, T0 - 7000),
      lastExecutionProof: proof(R77, T0 - 7000),
    }],
  } as unknown as ReleaseStateSnapshotV1;
  assert.equal(refreshFixActivation(proven, [pin(R77)]), T0 + 500);
  // R77's own recorded executions predate this pin, so it is not R77's
  // activation bound and never counts.
  assert.equal(
    refreshFixActivation({ ...proven, hostedReleases: [] }, [pin(R77)]),
    null,
  );
  // With no settlement at all, the pinned bound alone is the activation; a
  // bound that is not a positive safe integer never counts.
  const bare = releaseAt({
    revision: R77,
    generation: 77,
    healthy: null,
    settled: null,
  });
  assert.equal(refreshFixActivation(bare, [pin(R77)]), PINNED);
  for (const bound of [0, -1, Number.NaN, 1.5, Number.MAX_VALUE]) {
    assert.equal(refreshFixActivation(bare, [pin(R77, bound)]), null);
  }
});

Deno.test("refresh re-arm: release custody the parser refuses proves no corrected runtime", async () => {
  const record = await refusedRefresh();
  const fixed = FIXED();
  // An unparseable pointer (a non-positive generation) naming the allowlisted
  // revision over a valid earlier settlement.
  const malformed = {
    ...fixed,
    hostedRuntimes: [{ ...fixed.hostedRuntimes[0]!, generation: 0 }],
  } as unknown as ReleaseStateSnapshotV1;
  await expectRetained(record, malformed, "runtime");
});
