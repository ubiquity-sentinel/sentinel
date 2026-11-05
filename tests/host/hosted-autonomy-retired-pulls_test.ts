// A record retired because its source issue closed (live ai.ubq.fi #1325-#1327
// with Sentinel's #1329-#1331 left open) has its OWN open, unmerged pull
// request closed once, with one comment, and the settlement recorded so the
// next pass is a no-op. A foreign, merged or already closed pull request is
// never touched on GitHub.
import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  retiredPullMarker,
  runHostedRetiredPullPass,
} from "../../ops/hosted-autonomy-retired-pulls.ts";
import { HOSTED_AUTONOMY_RETIRED } from "../../ops/hosted-autonomy-policy.ts";
import { PULL_PROBE_BACKOFF_MS } from "../../ops/hosted-autonomy-pull-probe.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyHeadPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import { MemoryState } from "../repair/helpers.ts";
import { T0 } from "../state/helpers.ts";
import {
  BASE,
  FOREIGN_REPO,
  foreignRecord,
  HEAD,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";
import { createHostedDeliveryReads } from "../../ops/hosted-autonomy-github-delivery.ts";

const ID = "issue-ubiquity-ai.ubq.fi-1327" as WorkItemId;
const BRANCH = `sentinel/repair/${ID}`;
const PR = 1331;
const ISSUE = 1327;
const CLOSING = "0123456789abcdef0123456789abcdef01234567";

function retiredRecord(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  return foreignRecord({
    id: ID,
    source: { kind: "issue", id: String(ISSUE), revision: HEAD },
    related: { incidentId: null, issueNumber: ISSUE },
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: HOSTED_AUTONOMY_RETIRED,
      since: T0 + 3000,
    },
    evidence: [],
    target: {
      base: BASE,
      branch: BRANCH,
      checkpoint: null,
      head: HEAD,
      pr: PR,
    },
    updatedAt: T0 + 3000,
    ...overrides,
  });
}

class FakeSurface {
  calls: string[] = [];
  comments: { number: number; body: string }[] = [];
  issueOpen = false;
  constructor(public pull: HostedAutonomyHeadPullV1 | null) {}
  surface(): HostedAutonomyGitHubV1 {
    return {
      listPullsByHeadRef: (branch: string) => {
        this.calls.push(`list:${branch}`);
        return Promise.resolve(
          this.pull === null || this.pull.headRef !== branch ? [] : [{
            ...this.pull,
          }],
        );
      },
      readIssueClosingCommit: (number: number) => {
        this.calls.push(`issue:${number}`);
        return Promise.resolve({
          open: this.issueOpen,
          closingCommit: this.issueOpen ? null : CLOSING,
        });
      },
      readIssueOpen: (number: number) => {
        this.calls.push(`issueOpen:${number}`);
        return Promise.resolve(this.issueOpen);
      },
      closePull: (number: number) => {
        this.calls.push(`close:${number}`);
        if (this.pull !== null) this.pull = { ...this.pull, state: "closed" };
        return Promise.resolve(true);
      },
      commentIssue: (number: number, body: string) => {
        this.calls.push(`comment:${number}`);
        this.comments.push({ number, body });
        return Promise.resolve(true);
      },
    } as unknown as HostedAutonomyGitHubV1;
  }
}

function ownPull(
  overrides: Partial<HostedAutonomyHeadPullV1> = {},
): HostedAutonomyHeadPullV1 {
  return {
    number: PR,
    state: "open",
    merged: false,
    headSha: HEAD,
    headRef: BRANCH,
    baseRef: "main",
    author: "ubiquity-sentinel[bot]",
    ...overrides,
  };
}

async function rig(record: WorkRecordV1, fake: FakeSurface) {
  const state = new MemoryState();
  const seeded = await state.writeRepair(repairSnapshot([record], []), null);
  assert.ok(seeded.ok && seeded.value.status === "applied");
  let now = T0 + 10_000;
  const deps = {
    state,
    clock: { now: () => now++ },
    githubFor: (repository: { name: string }) =>
      repository.name === FOREIGN_REPO.name ? fake.surface() : null,
  } as unknown as HostedAutonomyDepsV1;
  const record0 = async () => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    return read.value.snapshot.work.find((row) => row.id === ID)!;
  };
  return { state, deps, record0 };
}

Deno.test("retired pull: Sentinel's own open unmerged pull is closed once with one comment", async () => {
  const fake = new FakeSurface(ownPull());
  const { state, deps, record0 } = await rig(retiredRecord(), fake);
  const writes = state.repairWrites;

  const first = await runHostedRetiredPullPass(deps);
  assert.deepEqual(fake.calls, [
    `list:${BRANCH}`,
    `issue:${ISSUE}`,
    `close:${PR}`,
    `comment:${PR}`,
  ]);
  assert.equal(fake.comments.length, 1);
  const body = fake.comments[0]!.body;
  assert.ok(body.startsWith(retiredPullMarker(ID)));
  assert.match(body, /source issue #1327 was closed by commit 0123456789/);
  assert.match(body, new RegExp(`branch \`${BRANCH}\` is kept`));
  assert.ok(first.includes(`retired-pull:${ID}:pr=${PR}:closed`), first.join());
  assert.equal(state.repairWrites, writes + 1);
  const settled = await record0();
  assert.equal(settled.retiredPullClosure?.pr, PR);
  assert.equal(settled.retiredPullClosure?.outcome, "closed");
  // Lifecycle, blocker and branch binding are unchanged.
  assert.equal(settled.nextStep, "blocked");
  assert.equal(settled.blocker?.message, HOSTED_AUTONOMY_RETIRED);
  assert.equal(settled.target.branch, BRANCH);

  // The second pass reads nothing, writes nothing, comments nothing.
  fake.calls = [];
  const second = await runHostedRetiredPullPass(deps);
  assert.deepEqual(second, []);
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.comments.length, 1);
  assert.equal(state.repairWrites, writes + 1);
});

for (
  const [name, pull, outcome] of [
    ["a foreign author", ownPull({ author: "a-person" }), "not_own"],
    [
      "an already merged pull",
      ownPull({ state: "closed", merged: true }),
      "merged",
    ],
    [
      "an already closed pull",
      ownPull({ state: "closed" }),
      "closed_elsewhere",
    ],
    ["no pull on the repair branch", null, "not_own"],
  ] as const
) {
  Deno.test(`retired pull: ${name} is never closed or commented on`, async () => {
    const fake = new FakeSurface(pull);
    const { deps, record0 } = await rig(retiredRecord(), fake);
    const actions = await runHostedRetiredPullPass(deps);
    assert.deepEqual(fake.calls, [`list:${BRANCH}`]);
    assert.equal(fake.comments.length, 0);
    assert.ok(actions.includes(`retired-pull:${ID}:pr=${PR}:${outcome}`));
    assert.equal((await record0()).retiredPullClosure?.outcome, outcome);
    fake.calls = [];
    assert.deepEqual(await runHostedRetiredPullPass(deps), []);
    assert.deepEqual(fake.calls, []);
  });
}

Deno.test("retired pull: a reopened issue keeps its pull open, settles `reopened` and returns the record to work", async () => {
  const fake = new FakeSurface(ownPull());
  fake.issueOpen = true;
  const retired = retiredRecord();
  const { state, deps, record0 } = await rig(retired, fake);
  const writes = state.repairWrites;
  const actions = await runHostedRetiredPullPass(deps);
  assert.deepEqual(fake.calls, [`list:${BRANCH}`, `issue:${ISSUE}`]);
  assert.deepEqual(actions, [
    `retired-pull:${ID}:pr=${PR}:reopened`,
    "retired-pull:recorded=1",
  ]);
  assert.equal(state.repairWrites, writes + 1);
  const record = await record0();
  assert.equal(record.retiredPullClosure?.outcome, "reopened");
  assert.equal(record.retiredPullClosure?.pr, PR);
  assert.equal(record.nextStep, "work");
  assert.equal(record.blocker, null);
  assert.deepEqual(record.target, retired.target, "pull request kept");
  assert.deepEqual(record.counters, retired.counters);
  assert.equal(fake.comments.length, 0);
  // Settled: the next pass reads nothing.
  fake.calls = [];
  assert.deepEqual(await runHostedRetiredPullPass(deps), []);
  assert.deepEqual(fake.calls, []);
});

Deno.test("retired pull: an unsettleable record backs off and the others get their turn", async () => {
  const fake = new FakeSurface(ownPull());
  const ids = Array.from(
    { length: 11 },
    (_, index) => `issue-ubiquity-ai.ubq.fi-${2000 + index}` as WorkItemId,
  );
  // Eleven pending records ahead of the settleable one; each is on another
  // repository whose pull listing cannot be read (`listing_unreadable`).
  const blocked = ids.map((id) =>
    retiredRecord({
      id,
      repository: { ...retiredRecord().repository, name: "unreachable" },
      target: { ...retiredRecord().target, branch: `sentinel/repair/${id}` },
    })
  );
  const state = new MemoryState();
  const seeded = await state.writeRepair(
    repairSnapshot([...blocked, retiredRecord()], []),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  let now = T0 + 10_000;
  const deps = {
    state,
    clock: { now: () => now },
    githubFor: (repository: { name: string }) =>
      repository.name === FOREIGN_REPO.name ? fake.surface() : {
        ...fake.surface(),
        listPullsByHeadRef: () => Promise.reject(new Error("unreadable")),
      },
  } as unknown as HostedAutonomyDepsV1;
  const snapshot = async () => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    return read.value.snapshot;
  };
  // Pass 1: the first ten are attempted once and stamped.
  const first = await runHostedRetiredPullPass(deps);
  assert.equal(
    first.filter((line) => line.endsWith(":listing_unreadable")).length,
    10,
  );
  assert.ok(first.includes("retired-pull:backoff=10"));
  let work = (await snapshot()).work;
  assert.deepEqual(
    work.filter((row) => row.pullProbe !== undefined).map((row) => row.id),
    ids.slice(0, 10),
  );
  assert.equal(work[0].pullProbe?.at, now);
  assert.equal(work[0].nextStep, "blocked", "only the stamp changed");
  assert.equal(work[0].updatedAt, blocked[0].updatedAt);
  // Pass 2 (five minutes later): the stamped ten are skipped; the eleventh
  // and the settleable record get their turn.
  now += 5 * 60_000;
  const second = await runHostedRetiredPullPass(deps);
  assert.ok(
    second.includes(`retired-pull:${ids[10]}:pr=${PR}:listing_unreadable`),
  );
  assert.ok(second.includes(`retired-pull:${ID}:pr=${PR}:closed`));
  assert.ok(!second.some((line) => line.includes(ids[0])));
  work = (await snapshot()).work;
  assert.equal(
    work.find((row) => row.id === ID)?.retiredPullClosure?.outcome,
    "closed",
  );
  // Pass 3 (inside every backoff): nothing is read.
  now += 5 * 60_000;
  fake.calls = [];
  assert.deepEqual(await runHostedRetiredPullPass(deps), []);
  // Past the backoff: the least recently probed are read first again.
  now += PULL_PROBE_BACKOFF_MS;
  const fourth = await runHostedRetiredPullPass(deps);
  assert.equal(
    fourth.filter((line) => line.endsWith(":listing_unreadable")).length,
    10,
  );
  assert.ok(!fourth.some((line) => line.includes(ids[10])));
});

for (
  const [name, surface] of [
    ["surface_unreadable", () => null],
    [
      "capability_absent",
      () => ({ readIssueOpen: () => Promise.resolve(false) }),
    ],
  ] as const
) {
  Deno.test(`retired pull: a repository whose surface is ${name} skips the pass with no read, stamp or write`, async () => {
    const fake = new FakeSurface(ownPull());
    const state = new MemoryState();
    const seeded = await state.writeRepair(
      repairSnapshot([retiredRecord()], []),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    let resolved = 0;
    const deps = {
      state,
      clock: { now: () => T0 + 10_000 },
      githubFor: () => {
        resolved++;
        return surface();
      },
    } as unknown as HostedAutonomyDepsV1;
    const writes = state.repairWrites;
    for (let pass = 0; pass < 2; pass++) {
      assert.deepEqual(await runHostedRetiredPullPass(deps), [
        `retired-pull:repo=${FOREIGN_REPO.owner}/${FOREIGN_REPO.name}:${name}`,
      ]);
    }
    assert.equal(resolved, 2, "one surface per repository per pass");
    assert.deepEqual(fake.calls, []);
    assert.equal(state.repairWrites, writes);
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.deepEqual(read.value.snapshot.work, [retiredRecord()]);
  });
}

Deno.test("retired pull: a record retired for any other reason is never read", async () => {
  const fake = new FakeSurface(ownPull());
  const { deps } = await rig(
    retiredRecord({
      blocker: {
        kind: "other",
        message: "PR publication identity mismatch",
        since: T0,
      },
    }),
    fake,
  );
  assert.deepEqual(await runHostedRetiredPullPass(deps), []);
  assert.deepEqual(fake.calls, []);
});

Deno.test("retired pull: a record the same pass retired waits for the next pass", async () => {
  // The retirement is that cycle's one write for the record: its pull
  // request is neither read, settled nor probe-stamped in the same cycle.
  const fake = new FakeSurface(ownPull());
  const { state, deps, record0 } = await rig(retiredRecord(), fake);
  const writes = state.repairWrites;
  assert.deepEqual(
    await runHostedRetiredPullPass(
      deps,
      Number.POSITIVE_INFINITY,
      deps.state,
      T0 + 3000,
    ),
    [],
  );
  assert.deepEqual(fake.calls, []);
  assert.equal(state.repairWrites, writes);
  assert.equal((await record0()).pullProbe, undefined);
  // The next pass, started after the retirement, settles it.
  const next = await runHostedRetiredPullPass(
    deps,
    Number.POSITIVE_INFINITY,
    deps.state,
    T0 + 3001,
  );
  assert.ok(next.includes(`retired-pull:${ID}:pr=${PR}:closed`));
});

Deno.test("retired pull: a discovery view with no pending record reads no guarded state", async () => {
  const fake = new FakeSurface(ownPull());
  const { deps } = await rig(retiredRecord(), fake);
  let guardedReads = 0;
  const guarded = {
    ...deps,
    state: {
      readRepair: () => {
        guardedReads++;
        return deps.state.readRepair();
      },
      writeRepair: deps.state.writeRepair.bind(deps.state),
    },
  } as unknown as HostedAutonomyDepsV1;
  const empty = new MemoryState();
  await empty.writeRepair(repairSnapshot([], []), null);
  assert.deepEqual(
    await runHostedRetiredPullPass(guarded, Number.POSITIVE_INFINITY, empty),
    [],
  );
  assert.equal(guardedReads, 0);
  assert.deepEqual(fake.calls, []);
  // A discovery view that shows the record runs the pass on the guarded read.
  const actions = await runHostedRetiredPullPass(
    guarded,
    Number.POSITIVE_INFINITY,
    deps.state,
  );
  assert.equal(guardedReads, 1);
  assert.ok(actions.includes(`retired-pull:${ID}:pr=${PR}:closed`));
});

Deno.test("retired pull: the GitHub close keeps the branch and proves closed unmerged", async () => {
  const sent: unknown[] = [];
  let reply: unknown = { number: PR, state: "closed", merged: false };
  const request = (method: string, path: string, body?: unknown) => {
    sent.push([method, path, body]);
    return Promise.resolve(reply);
  };
  const reads = createHostedDeliveryReads(
    request as Parameters<typeof createHostedDeliveryReads>[0],
    "ubiquity/ai.ubq.fi",
  );
  assert.equal(await reads.closePull(PR), true);
  // Only the pull request's state is patched: no ref is deleted.
  assert.deepEqual(sent, [[
    "PATCH",
    `/repos/ubiquity/ai.ubq.fi/pulls/${PR}`,
    { state: "closed" },
  ]]);
  reply = { number: PR, state: "closed", merged: true };
  assert.equal(await reads.closePull(PR), false);
  reply = { number: PR, state: "open", merged: false };
  assert.equal(await reads.closePull(PR), false);
  reply = null;
  assert.equal(await reads.closePull(PR), false);
  assert.equal(await reads.closePull(0), false);
});
