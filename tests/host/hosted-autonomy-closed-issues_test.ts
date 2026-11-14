import assert from "node:assert/strict";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  applyHostedRetirements,
  planHostedRetirements,
} from "../../ops/hosted-autonomy-closures.ts";
import {
  HOSTED_AUTONOMY_RETIRED,
  hostedIssueKey,
  hostedRepositoryKey,
} from "../../ops/hosted-autonomy-policy.ts";
import { readHostedClosedIssues } from "../../ops/hosted-autonomy-closed-issues.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
} from "../../ops/hosted-autonomy-types.ts";
import { REPO, SHA1, T0, workRecord } from "../state/helpers.ts";

type IssueLister = NonNullable<
  HostedAutonomyDepsV1["repairTiers"]
>["listOpenIssueNumbers"];

function issue(number: number): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    related: { incidentId: null, issueNumber: number },
  });
}

function harness(
  work: WorkRecordV1[],
  listOpenIssueNumbers?: IssueLister,
  answer: (number: number) => boolean | null = () => true,
) {
  const reads: number[] = [];
  const surface = {
    readDefaultBranch: () => Promise.resolve("main"),
    readIssueOpen: (number: number) => {
      reads.push(number);
      return Promise.resolve(answer(number));
    },
  } as HostedAutonomyGitHubV1;
  // Only the read-only ports exercised by this consumer are supplied.
  const deps = {
    githubFor: () => surface,
    clock: { now: () => T0 + 2_000 },
    ...(listOpenIssueNumbers === undefined ? {} : {
      repairTiers: { listOpenIssueNumbers },
    }),
  } as unknown as HostedAutonomyDepsV1;
  const context: HostedAutonomyPassContextV1 = {
    deps,
    actions: [],
    revisions: [],
    snapshot: parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 2_000,
      incidents: [],
      evidence: [],
      work,
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }),
    releaseSnapshot: parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      releases: [],
      hostedRuntimes: [],
      hostedReleases: [],
      githubCooldowns: [],
    }),
    observedHead: SHA1,
    initialHead: SHA1,
    closedIssues: new Set(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set(),
    ...createHostedAutonomyScopes(deps),
  };
  return { context, reads, surface };
}

Deno.test("maintenance: a hot tier of open issues uses one repository listing, not per-record GETs", async () => {
  const work = Array.from({ length: 60 }, (_, index) => issue(index + 1));
  let listings = 0;
  const { context, reads } = harness(work, () => {
    listings++;
    return Promise.resolve(portOk(work.map((row) => row.related.issueNumber!)));
  });
  const seen = new Set<string>();
  await readHostedClosedIssues(context, seen);
  assert.equal(listings, 1);
  assert.deepEqual(
    reads,
    [],
    "the listing positively proves these issues open",
  );
  assert.deepEqual([...context.closedIssues], []);
  assert.deepEqual([...seen], work.map((row) => row.id));
  await readHostedClosedIssues(context, seen);
  assert.equal(listings, 1, "a continued pass keeps its source facts");
});

Deno.test("maintenance: listing absence still needs an exact closed-issue read", async () => {
  const { context, reads } = harness(
    [1, 2, 3, 4].map(issue),
    () => Promise.resolve(portOk([1])),
    (number) => number === 2 ? false : number === 3 ? null : true,
  );
  await readHostedClosedIssues(context);
  assert.deepEqual(reads, [2, 3, 4]);
  assert.deepEqual([...context.closedIssues], [hostedIssueKey(REPO, 2)]);
  assert.deepEqual(
    planHostedRetirements(context.snapshot, context.closedIssues).map((row) =>
      row.id
    ),
    [issue(2).id],
    "a missing or unreadable issue never retires a record",
  );
});

Deno.test("maintenance: unavailable listings keep bounded per-record fallback and its facts", async () => {
  for (const mode of ["unavailable", "threw", "absent"] as const) {
    let listings = 0;
    const lister: IssueLister = () => {
      listings++;
      if (mode === "threw") throw new Error("listing unavailable");
      return Promise.resolve(portError("unavailable", "partial listing"));
    };
    const { context, reads } = harness(
      [1, 2, 3, 4, 5].map(issue),
      mode === "absent" ? undefined : lister,
      (number) => {
        if (number === 5) throw new Error("issue unavailable");
        return number === 3 ? null : number % 2 !== 0;
      },
    );
    const seen = new Set<string>();
    await readHostedClosedIssues(context, seen);
    assert.equal(listings, mode === "absent" ? 0 : 1);
    assert.deepEqual(reads, [1, 2, 3, 4, 5]);
    assert.deepEqual(
      [...context.closedIssues],
      [2, 4].map((n) => hostedIssueKey(REPO, n)),
    );
    assert.equal(seen.size, 5);
  }
});

Deno.test("maintenance: open facts are scoped by repository and installation", async () => {
  const otherInstallation = {
    ...REPO,
    installationId: REPO.installationId + 1,
  };
  const foreign = { ...REPO, name: "another-target" };
  const listed: string[] = [];
  const work = [
    issue(1),
    workRecord("other-installation", { repository: otherInstallation }),
    workRecord("other-repository", { repository: foreign }),
  ];
  const { context, reads } = harness(work, (repository) => {
    listed.push(hostedRepositoryKey(repository));
    return Promise.resolve(portOk(
      hostedRepositoryKey(repository) === hostedRepositoryKey(REPO) ? [1] : [],
    ));
  }, () => false);
  await readHostedClosedIssues(context);
  assert.deepEqual(
    listed,
    work.map((row) => hostedRepositoryKey(row.repository)),
  );
  assert.deepEqual(reads, [1, 1]);
  assert.deepEqual([...context.closedIssues], [
    hostedIssueKey(otherInstallation, 1),
    hostedIssueKey(foreign, 1),
  ]);
});

Deno.test("maintenance: a later cycle observes closure, retires once and keeps open work untouched", async () => {
  let listings = 0;
  let open = [1, 2];
  const { context, reads } = harness(
    [1, 2].map(issue),
    () => {
      listings++;
      return Promise.resolve(portOk(open));
    },
    (number) => open.includes(number),
  );
  await readHostedClosedIssues(context);
  assert.deepEqual(reads, []);
  assert.deepEqual(
    planHostedRetirements(context.snapshot, context.closedIssues),
    [],
  );

  open = [2];
  await readHostedClosedIssues(context);
  assert.equal(listings, 2, "no listing is cached across cycles");
  assert.deepEqual(reads, [1]);
  const plans = planHostedRetirements(context.snapshot, context.closedIssues);
  assert.deepEqual(plans.map((row) => row.id), [issue(1).id]);
  context.snapshot = applyHostedRetirements(
    context.snapshot,
    SHA1,
    plans,
    T0 + 3_000,
  );
  assert.equal(
    context.snapshot.work[0].blocker?.message,
    HOSTED_AUTONOMY_RETIRED,
  );
  assert.deepEqual(context.snapshot.work[1], issue(2));

  await readHostedClosedIssues(context);
  assert.equal(listings, 3);
  assert.deepEqual(reads, [1], "retired work costs no source-issue read");
  assert.deepEqual(
    planHostedRetirements(context.snapshot, context.closedIssues),
    [],
  );
});

Deno.test("maintenance: done, retired, protected and unreadable surfaces do not trigger listings", async () => {
  let listings = 0;
  const work = [
    workRecord("done", { nextStep: "done" }),
    workRecord("retired", {
      nextStep: "blocked",
      blocker: { kind: "other", message: HOSTED_AUTONOMY_RETIRED, since: T0 },
      related: { incidentId: null, issueNumber: 2 },
    }),
    workRecord("protected", { related: { incidentId: null, issueNumber: 3 } }),
    workRecord("no-issue", {
      source: { kind: "incident", id: "incident", revision: SHA1 },
      fingerprint: "d".repeat(64),
      related: { incidentId: "incident", issueNumber: null },
    }),
    workRecord("unreadable", { related: { incidentId: null, issueNumber: 4 } }),
  ];
  const { context, reads } = harness(work, () => {
    listings++;
    return Promise.resolve(portOk([]));
  });
  Object.assign(context.deps, {
    queueCustody: { protectedRecordIds: new Set(["protected"]) },
    githubFor: () => null,
  });
  const seen = new Set<string>();
  await readHostedClosedIssues(context, seen);
  assert.equal(listings, 0);
  assert.deepEqual(reads, []);
  assert.deepEqual([...seen], ["unreadable"]);
  assert.deepEqual(context.actions, ["record:unreadable:surface_unreadable"]);
  assert.deepEqual([...context.closedIssues], []);
});
