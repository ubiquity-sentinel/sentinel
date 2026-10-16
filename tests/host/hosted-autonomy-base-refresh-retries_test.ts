/**
 * Launcher re-admission of base-refresh terminal blocks, through the REAL
 * protected maintenance pass over a real Git release store and fake GitHub
 * surfaces, with sanitized copies of the live ai.ubq.fi records (issues 629
 * and 641):
 *
 * - "base refresh failed 3 consecutive times: auth_failed ...": a per-job
 *   credential expiry, re-admitted only while its PR is still open and owned
 *   on the exact branch, restoring target.pr from that verified PR only and
 *   charging nothing;
 * - "base refresh has conflicts" (legacy) / "... at <base>": never
 *   re-admitted; the record stays a visible terminal block.
 *
 * Every written snapshot is parsed by the generation-76 rollback parsers. No
 * network, no model call, no credentials.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  applyBaseRefreshReadmissions,
  BASE_REFRESH_AUTH_BLOCKERS,
  decideBaseRefreshReadmission,
  HOSTED_AUTONOMY_MAX_RETRIES,
  hostedIssueKey,
  parseHostedAutonomyHeadPulls,
  planBaseRefreshReadmissions,
} from "../../ops/hosted-autonomy.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import {
  assertGen76Parses,
  assertGen76Shape,
  GEN76_RUNTIME,
  gen76Available,
} from "../state/gen76-contracts.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";

const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const OLD_BASE = "0dbee0047f76a18b1b1a51ca198a25e01e92603f" as GitSha;
const AUTH_BASE = "0ee5d86788d2bc42947ba60436e2f71426128d4b" as GitSha;
/** The Bun-migrated ai.ubq.fi tip the old candidates conflict with. */
const TIP = "d28cefa0d28cefa0d28cefa0d28cefa0d28cefa0" as GitSha;
const H629 = "fb13748a26f29b86f43d6202c89bbf253f111c06" as GitSha;
const H641 = "c68c87d69de4680d56576cb8fb1c068117b572f5" as GitSha;
const APP_AUTHOR = "ubiquity-sentinel[bot]";
const AUTH_MESSAGE =
  "base refresh failed 3 consecutive times: auth_failed own pull request could not be observed";

/** Sanitized copy of one live terminally blocked ai.ubq.fi record. */
function liveBlocked(
  issue: number,
  head: GitSha,
  base: GitSha,
  message: string,
  counters: Record<string, number>,
): WorkRecordV1 {
  const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
  return parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: AI,
    id,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    fingerprint: null,
    failingRevision: null,
    sourceSnapshotDigest: null,
    classification: { severity: "P2", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    dependencies: [],
    controller: { sha: SHA1 },
    target: {
      base,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head,
      pr: null,
      candidateState: {
        preserved: {
          operationKey: `impl:${String(issue).padStart(4, "0").repeat(16)}`,
          base,
          head,
          ref: `refs/heads/sentinel-candidates/${
            String(issue).padStart(4, "0").repeat(16)
          }`,
        },
        publishedHead: head,
      },
    },
    nextStep: "blocked",
    wait: null,
    blocker: { kind: "other", message, since: T0 + 1000 },
    counters,
    evidence: [],
    intent: null,
    firstSeenAt: T0,
    createdAt: T0 + 100,
    updatedAt: T0 + 1000,
  });
}

function conflictRecord(message = "base refresh has conflicts"): WorkRecordV1 {
  return liveBlocked(629, H629, OLD_BASE, message, {
    attempts: 4,
    retries: 0,
    reviewRounds: 1,
  });
}

function authRecord(message = AUTH_MESSAGE): WorkRecordV1 {
  return liveBlocked(641, H641, AUTH_BASE, message, {
    attempts: 4,
    retries: 0,
    reviewRounds: 0,
  });
}

interface HeadPullFixtureV1 {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  author: string | null;
}

function openPull(
  number: number,
  record: WorkRecordV1,
  overrides: Partial<HeadPullFixtureV1> = {},
): HeadPullFixtureV1 {
  return {
    number,
    state: "open",
    merged: false,
    headSha: record.target.head!,
    headRef: record.target.branch!,
    baseRef: "main",
    author: APP_AUTHOR,
    ...overrides,
  };
}

/** Rig over the live-like snapshot with exact per-branch remote facts. */
async function liveRig(
  records: WorkRecordV1[],
  pulls: Record<string, HeadPullFixtureV1[] | null>,
  reservations: unknown[] = [],
) {
  const { rig, github } = await makeRig("base-refresh-readmit", {
    repair: repairSnapshot(records, [], [], reservations),
    branchTip: (branch) =>
      branch === "main"
        ? TIP
        : records.find((record) => record.target.branch === branch)?.target
          .head ?? null,
  });
  const surface = Object.assign(github, {
    listPullsByHeadRef: (branch: string) =>
      Promise.resolve(pulls[branch] === undefined ? [] : pulls[branch]),
  });
  return { rig, surface };
}

async function readSnapshot(
  rig: Awaited<ReturnType<typeof liveRig>>["rig"],
): Promise<RepairStateSnapshotV1> {
  const read = await rig.state.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("unreadable");
  return read.value.snapshot;
}

Deno.test(
  "base refresh re-admission: a live credential block returns to work in one verified write; a live conflict block stays blocked",
  async () => {
    const conflict = conflictRecord();
    const auth = authRecord();
    const { rig, surface } = await liveRig([conflict, auth], {
      [conflict.target.branch!]: [openPull(998, conflict)],
      [auth.target.branch!]: [openPull(1007, auth)],
    });
    try {
      const result = await run(rig, surface);
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(result.reason, "retried");
      assert.equal(rig.writes, 1, "one CAS write");
      const snapshot = await readSnapshot(rig);
      assertGen76Shape(snapshot);

      // Credential: the verified open PR is restored, nothing else moves.
      const resumed = snapshot.work.find((row) => row.id === auth.id)!;
      assert.equal(resumed.nextStep, "work");
      assert.equal(resumed.blocker, null);
      assert.equal(resumed.intent, null);
      assert.equal(resumed.wait, null);
      assert.equal(resumed.target.pr, 1007);
      assert.deepEqual(
        { ...resumed.target, pr: null },
        auth.target,
        "only target.pr is restored",
      );
      assert.deepEqual(resumed.counters, auth.counters);
      assert.equal(snapshot.reservations.length, 0, "nothing is charged");
      assert.ok(
        result.actions.includes(
          `retry:${auth.id}:readmit:base_refresh_auth_expired`,
        ),
        JSON.stringify(result.actions),
      );

      // Conflict: untouched, and no action names it.
      assert.deepEqual(
        snapshot.work.find((row) => row.id === conflict.id),
        conflict,
      );
      assert.ok(
        !result.actions.some((action) =>
          action.startsWith(`retry:${conflict.id}:`)
        ),
        JSON.stringify(result.actions),
      );
      if (await gen76Available()) await assertGen76Parses(snapshot);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

const OTHER_BASE = "3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a" as GitSha;

function charge(
  id: string,
  record: WorkRecordV1,
  head: GitSha,
  attempt: number,
) {
  return reservation(id, {
    repository: AI,
    taskId: record.id,
    head,
    attempt,
    purpose: "retry",
    outcome: "submitted",
    settledAt: T0 + 50,
  });
}

function plan(
  records: WorkRecordV1[],
  reservations: unknown[] = [],
  closed: ReadonlySet<string> = new Set(),
) {
  const denials: string[] = [];
  const candidates = planBaseRefreshReadmissions(
    repairSnapshot(records, [], [], reservations),
    SHA1,
    closed,
    (denial) => denials.push(`${denial.id}:${denial.reason}`),
  );
  return { candidates, denials };
}

Deno.test(
  "base refresh re-admission: the retry-budget and closed-issue gates apply",
  () => {
    const auth = authRecord();
    assert.equal(plan([auth]).candidates.length, 1);
    const budget = Array.from(
      { length: HOSTED_AUTONOMY_MAX_RETRIES },
      (_, index) => charge(`a-${index}`, auth, OTHER_BASE, index + 1),
    );
    assert.equal(
      plan([auth], budget).candidates.length,
      0,
      "the credential rule shares the retry budget",
    );
    assert.equal(
      plan([auth], [], new Set([hostedIssueKey(AI, 641)])).candidates.length,
      0,
      "closed source issue",
    );
  },
);

Deno.test(
  "base refresh re-admission: only the exact credential-expiry messages and terminal shapes qualify",
  () => {
    assert.equal(BASE_REFRESH_AUTH_BLOCKERS.size, 6);
    for (const message of BASE_REFRESH_AUTH_BLOCKERS) {
      assert.deepEqual(
        plan([authRecord(message)]).candidates.map((candidate) =>
          candidate.head
        ),
        [H641],
      );
    }
    for (
      const message of [
        "base refresh failed 2 consecutive times: auth_failed own pull request could not be observed",
        "base refresh failed 3 consecutive times: unavailable own pull request could not be observed",
        "base refresh failed 3 consecutive times: unavailable candidate could not be preserved",
        `${AUTH_MESSAGE} (again)`,
        `${AUTH_MESSAGE} (permission refused)`,
        "base refresh has conflicts",
        `base refresh has conflicts at ${OLD_BASE}`,
      ]
    ) {
      const result = plan([authRecord(message)]);
      assert.equal(result.candidates.length, 0, message);
      assert.deepEqual(result.denials, [], message);
    }
    // A still-live wait is not the terminal shape.
    const waiting = parseWorkRecordV1({
      ...authRecord(),
      wait: { reason: "unavailable", since: T0, until: T0 + 1 },
    });
    assert.equal(plan([waiting]).candidates.length, 0);
    // The credential class keeps its exact cleared-PR terminal shape.
    const withPr = parseWorkRecordV1({
      ...authRecord(),
      target: { ...authRecord().target, pr: 1007 },
    });
    assert.equal(plan([withPr]).candidates.length, 0);
    // A candidate whose published head is not its head is refused and
    // reported.
    const unpublished = parseWorkRecordV1({
      ...authRecord(),
      target: {
        ...authRecord().target,
        candidateState: {
          ...authRecord().target.candidateState!,
          publishedHead: null,
        },
      },
    });
    const result = plan([unpublished]);
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.denials, [
      `${unpublished.id}:unpublished_candidate`,
    ]);
  },
);

Deno.test(
  "base refresh re-admission: remote verification binds the owned open PR, the exact branch and its published head",
  async () => {
    const auth = plan([authRecord()]).candidates[0];
    const open641 = openPull(1007, authRecord());
    const decide = (
      pulls: HeadPullFixtureV1[] | null,
      tip: string | null = auth.head,
    ) => decideBaseRefreshReadmission(auth, pulls, tip, "main");
    const reason = (decision: ReturnType<typeof decide>) =>
      decision.kind === "refused" ? decision.reason : "readmit";

    const resumed = decide([open641]);
    assert.equal(resumed.kind, "readmit");
    if (resumed.kind !== "readmit") return;
    assert.deepEqual(resumed.readmission, {
      id: authRecord().id,
      repository: AI,
      pullRequest: 1007,
      detail: "base_refresh_auth_expired",
    });
    // An older closed PR on the same branch does not hide the open one.
    assert.equal(
      reason(decide([{ ...open641, number: 1000, state: "closed" }, open641])),
      "readmit",
    );
    assert.equal(reason(decide([])), "pr_not_open");
    assert.equal(
      reason(decide([{ ...open641, state: "closed" }])),
      "pr_not_open",
    );
    assert.equal(
      reason(decide([{ ...open641, state: "closed", merged: true }])),
      "pr_merged",
    );
    assert.equal(
      reason(decide([{ ...open641, author: "someone" }])),
      "pr_foreign",
    );
    assert.equal(reason(decide([{ ...open641, author: null }])), "pr_foreign");
    assert.equal(
      reason(decide([{ ...open641, headSha: OTHER_BASE }])),
      "pr_foreign",
    );
    assert.equal(
      reason(decide([{ ...open641, baseRef: "development" }])),
      "pr_foreign",
    );
    assert.equal(
      reason(decide([open641, { ...open641, number: 1008 }])),
      "pr_ambiguous",
    );
    assert.equal(reason(decide(null)), "pr_read_failed");
    assert.equal(reason(decide([open641], OTHER_BASE)), "branch_moved");
    assert.equal(reason(decide([open641], null)), "branch_moved");
    assert.equal(
      reason(decide([{ ...open641, headRef: "elsewhere" }])),
      "pr_listing_mismatch",
    );
    assert.equal(
      reason(decideBaseRefreshReadmission(auth, [open641], H641, null)),
      "base_branch_unknown",
    );

    // The transition keeps charged history and every reservation as is.
    const charges = [charge("r-older", authRecord(), AUTH_BASE, 7)];
    const snapshot = repairSnapshot([authRecord()], [], [], charges);
    const next = applyBaseRefreshReadmissions(
      snapshot,
      [resumed.readmission],
      T0 + 6000,
    );
    assert.deepEqual(next.work[0].counters, authRecord().counters);
    assert.deepEqual(next.reservations, snapshot.reservations, "no refund");
    assert.equal(next.work[0].target.pr, 1007);
    assertGen76Shape(next);
    if (await gen76Available()) await assertGen76Parses(next);
  },
);

Deno.test(
  "base refresh re-admission: the exact-branch listing parser refuses forks, other branches and unprovable pages",
  () => {
    const scope = "ubiquity/ai.ubq.fi";
    const branch = "sentinel/repair/issue-ubiquity-ai.ubq.fi-641";
    const raw = (overrides: Record<string, unknown> = {}) => ({
      number: 1007,
      state: "open",
      merged_at: null,
      head: { ref: branch, sha: H641, repo: { full_name: scope } },
      base: { ref: "main" },
      user: { login: APP_AUTHOR },
      ...overrides,
    });
    assert.deepEqual(
      parseHostedAutonomyHeadPulls([raw()], scope, branch, 100),
      [{
        number: 1007,
        state: "open",
        merged: false,
        headSha: H641,
        headRef: branch,
        baseRef: "main",
        author: APP_AUTHOR,
      }],
    );
    assert.equal(
      parseHostedAutonomyHeadPulls(
        [raw({ state: "closed", merged_at: "2026-10-15T00:00:00Z" })],
        scope,
        branch,
        100,
      )?.[0].merged,
      true,
    );
    assert.deepEqual(parseHostedAutonomyHeadPulls([], scope, branch, 100), []);
    for (
      const refused of [
        [raw({ head: { ref: branch, sha: H641, repo: { full_name: "x/y" } } })],
        [raw({
          head: { ref: "other", sha: H641, repo: { full_name: scope } },
        })],
        [raw({ state: "draft" })],
        [raw({ number: 0 })],
        [raw({
          head: { ref: branch, sha: "main", repo: { full_name: scope } },
        })],
        Array.from({ length: 100 }, () => raw()),
      ]
    ) {
      assert.equal(
        parseHostedAutonomyHeadPulls(refused, scope, branch, 100),
        null,
      );
    }
    assert.equal(parseHostedAutonomyHeadPulls(null, scope, branch, 100), null);
  },
);

Deno.test(
  "base refresh re-admission: a surface without the exact-branch listing re-admits nothing",
  async () => {
    const auth = authRecord();
    const { rig, github } = await makeRig("base-refresh-readmit-none", {
      repair: repairSnapshot([auth]),
      branchTip: (branch) => branch === "main" ? TIP : H641,
    });
    try {
      const result = await run(rig, github);
      assert.equal(rig.writes, 0, JSON.stringify(result));
      assert.ok(
        result.actions.includes(
          `retry:${auth.id}:skipped:pr_lookup_unavailable`,
        ),
        JSON.stringify(result.actions),
      );
      assert.equal((await readSnapshot(rig)).work[0].nextStep, "blocked");
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

Deno.test(
  "base refresh re-admission: a branch that no longer carries the published head is refused before any pull listing",
  async () => {
    const auth = authRecord();
    const { rig, github } = await makeRig("base-refresh-moved", {
      repair: repairSnapshot([auth], [], [], []),
      branchTip: (branch) => branch === "main" ? TIP : OTHER_BASE,
    });
    const listed: string[] = [];
    const surface = Object.assign(github, {
      listPullsByHeadRef: (branch: string) => {
        listed.push(branch);
        return Promise.resolve([openPull(1007, auth)]);
      },
    });
    try {
      const result = await run(rig, surface);
      assert.ok(
        result.actions.includes(`retry:${auth.id}:skipped:branch_moved`),
        JSON.stringify(result.actions),
      );
      assert.deepEqual(listed, [], "a lasting refusal reads no pull listing");
      const snapshot = await readSnapshot(rig);
      assert.equal(snapshot.work[0].nextStep, "blocked");
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

Deno.test(
  "base refresh re-admission: nothing is re-admitted while the generation-76 rollback runtime is active",
  () => {
    const auth = authRecord();
    const snapshot = repairSnapshot([auth], [], [], []);
    const denials: string[] = [];
    // Generation 76 counts every credential expiry, so a re-admission could
    // cycle block -> re-admit without any charge.
    const candidates = planBaseRefreshReadmissions(
      snapshot,
      GEN76_RUNTIME as GitSha,
      new Set(),
      (denial) => denials.push(`${denial.id}:${denial.reason}`),
    );
    assert.deepEqual(candidates, []);
    assert.deepEqual(denials, [
      `${auth.id}:runtime_lacks_credential_deferral`,
    ]);
    // Any other runtime revision plans it exactly as before.
    assert.equal(
      planBaseRefreshReadmissions(snapshot, SHA1, new Set()).length,
      1,
    );
  },
);

Deno.test(
  "base refresh re-admission: a conflict block (legacy or exact base) is never re-admitted",
  async () => {
    const legacy = conflictRecord();
    const exact = liveBlocked(
      630,
      H641,
      OLD_BASE,
      `base refresh has conflicts at ${OLD_BASE}`,
      { attempts: 4, retries: 0, reviewRounds: 1 },
    );
    const { rig, surface } = await liveRig([legacy, exact], {
      [legacy.target.branch!]: [openPull(998, legacy)],
      [exact.target.branch!]: [openPull(999, exact)],
    });
    try {
      const before = await readSnapshot(rig);
      const result = await run(rig, surface);
      assert.equal(rig.writes, 0, JSON.stringify(result));
      assert.ok(
        !result.actions.some((action) =>
          action.startsWith(`retry:${legacy.id}:`) ||
          action.startsWith(`retry:${exact.id}:`)
        ),
        JSON.stringify(result.actions),
      );
      assert.deepEqual((await readSnapshot(rig)).work, before.work);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);
