/**
 * Maintenance read cost (live 2026-10-24): 115 of the 388 non-done records
 * were already retired (blocked on `HOSTED_AUTONOMY_RETIRED`, the terminal
 * park of a closed source issue), yet every pass read each one's source issue
 * (`readHostedClosedIssues`, one sequential read each, 85 seconds for all)
 * and the closure pass read the pull request of the 24 retired records that
 * had one, although no rule ever acts on a retired record's issue or pull.
 *
 * A retired record now costs no read, every verdict stays what it was (its
 * issue's closed fact never changes one), and the remaining issue reads run
 * at most `CLOSED_ISSUE_READ_CONCURRENCY` at a time, applied in record order.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_AUTONOMY_RETIRED,
  hostedIssueKey,
  planBaseRefreshReadmissions,
  planHostedRetirements,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import {
  acceptanceOwnerGateActions,
  planAcceptanceReadmissions,
} from "../../ops/hosted-autonomy-acceptance.ts";
import { readHostedClosedIssues } from "../../ops/hosted-autonomy-retry-pass.ts";
import { CLOSED_ISSUE_READ_CONCURRENCY } from "../../ops/hosted-autonomy-closed-issues.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
} from "../../ops/hosted-autonomy-types.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  deliveryRecord,
  FOREIGN_REPO,
  pullFacts,
  SELF_REPO,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  releaseSnapshot,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

const RUNTIME = SHA1 as GitSha;

/** An issue task of `repository` for issue `n` with its own pull request. */
function issueTask(
  n: number,
  overrides: Record<string, unknown> = {},
  repository: typeof SELF_REPO | typeof FOREIGN_REPO = SELF_REPO,
): WorkRecordV1 {
  const slug = `${repository.owner}-${repository.name}`;
  return deliveryRecord({
    id: `issue-${slug}-${n}`,
    repository,
    source: { kind: "issue", id: String(n), revision: SHA1 },
    related: { incidentId: null, issueNumber: n },
    target: {
      ...deliveryRecord().target,
      branch: `sentinel/repair/issue-${slug}-${n}`,
      pr: 300 + n,
    },
    ...overrides,
  });
}

/** The retirement park of issue `n` (`applyHostedRetirements`). */
function retired(
  n: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return issueTask(n, {
    nextStep: "blocked",
    wait: null,
    intent: null,
    blocker: { kind: "other", message: HOSTED_AUTONOMY_RETIRED, since: T0 },
    ...overrides,
  });
}

Deno.test("maintenance: a retired record costs no issue or pull read, and the pass is unchanged by its issue", async () => {
  const runs = [];
  for (const open of [false, true, null]) {
    const record = retired(61);
    const { rig, github } = await makeRig(`retired-reads-${open}`, {
      repair: repairSnapshot([record], [authorizingReceipt()]),
      pull: pullFacts({
        number: record.target.pr!,
        state: "closed",
        merged: false,
        mergeCommitSha: null,
      }),
    });
    const issues: number[] = [];
    const pulls: number[] = [];
    const counting: HostedAutonomyGitHubV1 = {
      ...github,
      readIssueOpen: (number) => {
        issues.push(number);
        return Promise.resolve(open);
      },
      readPull: (number, base) => {
        pulls.push(number);
        return github.readPull(number, base);
      },
    };
    const result = await run(rig, counting);
    assert.deepEqual(issues.filter((n) => n === 61), [], `${open}: issue`);
    assert.deepEqual(pulls.filter((n) => n === 361), [], `${open}: pull`);
    assert.equal(rig.writes, 0, `${open}`);
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.deepEqual(read.value.snapshot.work, [record]);
    runs.push({ status: result.status, actions: result.actions });
    await Deno.remove(rig.tmp, { recursive: true });
  }
  // Closed, reopened or unreadable: the same pass.
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
});

Deno.test("maintenance: a retired part of a closed live issue costs no pull read", async () => {
  // The live part keeps the issue read (and its own pull read); the retired
  // part's closed-unmerged pull request is not read again.
  const live = issueTask(80);
  const part = retired(80, {
    id: "issue-ubiquity-sentinel-sentinel-80-part-2-of-2",
    target: {
      ...issueTask(80).target,
      branch: "sentinel/repair/issue-ubiquity-sentinel-sentinel-80-part-2",
      pr: 480,
    },
  });
  const { rig, github } = await makeRig("retired-part-reads", {
    repair: repairSnapshot([live, part], [authorizingReceipt()]),
  });
  const issues: number[] = [];
  const pulls: number[] = [];
  const counting: HostedAutonomyGitHubV1 = {
    ...github,
    readIssueOpen: (number) => {
      issues.push(number);
      return Promise.resolve(false);
    },
    readPull: (number) => {
      pulls.push(number);
      return Promise.resolve(pullFacts({ number }));
    },
  };
  await run(rig, counting);
  assert.ok(issues.includes(80), JSON.stringify(issues));
  assert.ok(pulls.includes(live.target.pr!), JSON.stringify(pulls));
  assert.ok(!pulls.includes(480), JSON.stringify(pulls));
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  assert.deepEqual(
    read.value.snapshot.work.find((row) => row.id === part.id),
    part,
  );
  await Deno.remove(rig.tmp, { recursive: true });
});

Deno.test("maintenance: no rule's verdict on a retired record depends on its issue's closed fact", () => {
  const records = [
    retired(70),
    retired(71, {
      target: { ...issueTask(71).target, head: null, pr: null },
    }),
    retired(72, {
      counters: { attempts: 3, retries: 3, reviewRounds: 3 },
    }),
  ];
  const snapshot = repairSnapshot(records, [authorizingReceipt()]);
  const keys = new Set(
    records.map((row) =>
      hostedIssueKey(row.repository, row.related.issueNumber!)
    ),
  );
  const verdicts = (closed: ReadonlySet<string>) => {
    const denied: unknown[] = [];
    return {
      retries: planHostedRetries(
        snapshot,
        T0 + 9_000_000,
        RUNTIME,
        new Map(),
        closed,
        (denial) => denied.push(denial),
      ),
      retirements: planHostedRetirements(
        snapshot,
        closed,
        new Set(records.map((row) => row.id)),
      ),
      acceptance: planAcceptanceReadmissions(
        snapshot,
        closed,
        true,
        (denial) => denied.push(denial),
      ),
      ownerGate: acceptanceOwnerGateActions(snapshot, closed),
      baseRefresh: planBaseRefreshReadmissions(
        snapshot,
        RUNTIME,
        closed,
        (denial) => denied.push(denial),
        true,
      ),
      denied,
    };
  };
  const closed = verdicts(keys);
  assert.deepEqual(closed, verdicts(new Set()));
  assert.deepEqual(closed.retirements, [], "never planned again");
  assert.deepEqual(closed.retries, []);
});

/** A self surface whose issue reads finish out of order, with their peak. */
function slowSurface(answer: (issue: number) => boolean | null) {
  const reads: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const surface = {
    readDefaultBranch: () => Promise.resolve("main"),
    readIssueOpen: async (issue: number) => {
      reads.push(issue);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2 + (issue * 7) % 11));
      inFlight--;
      return answer(issue);
    },
  } as unknown as HostedAutonomyGitHubV1;
  return { surface, reads, peak: () => peak };
}

function passContext(
  work: WorkRecordV1[],
  githubFor: HostedAutonomyDepsV1["githubFor"],
): HostedAutonomyPassContextV1 {
  const deps = {
    githubFor,
    clock: { now: () => T0 + 9_000_000 },
  } as unknown as HostedAutonomyDepsV1;
  return {
    deps,
    actions: [],
    revisions: [],
    snapshot: repairSnapshot(work, []),
    observedHead: SHA1,
    initialHead: SHA1,
    releaseSnapshot: releaseSnapshot(),
    closedIssues: new Set(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set(),
    ...createHostedAutonomyScopes(deps),
  };
}

Deno.test("maintenance: issue reads run a few at a time and apply in record order", async () => {
  const foreign = (n: number) => issueTask(n, {}, FOREIGN_REPO);
  const work = [
    issueTask(1),
    foreign(2),
    issueTask(3),
    issueTask(4),
    retired(5),
    issueTask(6),
    foreign(7),
    issueTask(8),
    issueTask(9),
    issueTask(10),
    issueTask(12),
    // A retired decomposition part of a live issue keeps its read.
    retired(12, { id: "issue-ubiquity-sentinel-sentinel-12-part-2-of-2" }),
    retired(13),
    issueTask(14, { nextStep: "done" }),
  ];
  // Even issues closed, odd ones open, every fifth unreadable.
  const { surface, reads, peak } = slowSurface((issue) =>
    issue % 5 === 0 ? null : issue % 2 !== 0
  );
  const context = passContext(
    work,
    (repository) => repository.owner === FOREIGN_REPO.owner ? null : surface,
  );
  const seen = new Set<string>();
  await readHostedClosedIssues(context, seen);
  assert.deepEqual(
    [...reads].sort((a, b) => a - b),
    [1, 3, 4, 6, 8, 9, 10, 12, 12],
  );
  assert.ok(peak() > 1, `peak ${peak()}`);
  assert.ok(peak() <= CLOSED_ISSUE_READ_CONCURRENCY, `peak ${peak()}`);
  const key = (n: number) => hostedIssueKey(SELF_REPO, n);
  assert.deepEqual(
    [...context.closedIssues].sort(),
    [key(4), key(6), key(8), key(12)].sort(),
  );
  assert.deepEqual(context.actions, [
    `record:${foreign(2).id}:surface_unreadable`,
    `record:${foreign(7).id}:surface_unreadable`,
  ]);
  const read = work.filter((row) =>
    row.nextStep !== "done" && row.id !== retired(5).id &&
    row.id !== retired(13).id
  ).map((row) => row.id);
  assert.deepEqual([...seen], read);
  // A continuation of the same pass reads nothing again and keeps the facts.
  await readHostedClosedIssues(context, seen);
  assert.equal(reads.length, 9);
  assert.equal(context.closedIssues.size, 4);
});
