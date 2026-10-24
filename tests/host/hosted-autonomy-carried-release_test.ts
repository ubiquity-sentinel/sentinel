/**
 * Sentinel #152, launcher half: the live 618 shape (PR 1071) is a carried
 * delivery: the merged refreshed head H1 on tip T waits at `delivery` beside
 * a production request that names the clean App review of the earlier head
 * H0 on B0. Once the release path accepts that request, the closure pass
 * accepts and closes it only after re-deriving the exact tree proof
 * (`mergeBaseTreeChanges`: equal change sets of merge-base(B0, H0) -> H0 and
 * T -> H1, T the refreshed side's merge base), authorizing the task as of
 * the reviewed identity; a request whose patch no longer proves is refused.
 */
import assert from "node:assert/strict";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import { withHistoricalQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import {
  darkQueueCoordinatorFixture,
  historicalDarkQueueFixture,
} from "./hosted-autonomy-dark-queue-fixture.ts";
import { makeRig } from "./hosted-autonomy-rig.ts";
import {
  LIVE_PULLS,
  LIVE_RECORDS,
  LIVE_REQUESTS,
  LIVE_REVIEWS,
  LIVE_TASKS,
  LIVE_UPDATED_AT,
} from "../repair/release-deferred-fixtures.ts";
import { persistVpsDelivery } from "../repair/vps-delivery-fixtures.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import {
  carriedGatewayRequestBindsDelivery,
  gatewayRequestBindsDelivery,
} from "../../src/repair/vps-delivery.ts";
import { authorizingReceipt } from "../../ops/hosted-autonomy-delivery.ts";
import {
  releaseAuthorizingReceipt,
  treeCarriedReleaseProver,
} from "../../ops/hosted-autonomy-carried-release.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy.ts";
import type { HostedTreeChangeV1 } from "../../ops/hosted-autonomy-github-trees.ts";

type HistoricalRunner =
  typeof import("../../ops/hosted-autonomy-runner.ts").runHostedAutonomy;
function historicalTest(
  name: string,
  check: (run: HistoricalRunner) => Promise<void>,
) {
  Deno.test(
    name,
    () =>
      withHostedProductionPolicy(
        DORMANT_HOSTED_SUPERVISOR_POLICY,
        async (graph) => {
          const runner = await graph.runner();
          await check(runner.runHostedAutonomy);
        },
      ),
  );
}

const NOW = LIVE_UPDATED_AT + 600_000;
/** The live carried record 618, its request and the receipt it names. */
const RECORD = LIVE_RECORDS.find((record) =>
  record.related.issueNumber === 618
)!;
const REQUEST = LIVE_REQUESTS.find((request) =>
  request.source.pullRequest === RECORD.target.pr
)!;
const RECEIPT = LIVE_REVIEWS.find((review) =>
  review.id === REQUEST.source.reviewReceiptId
)!;
const H0 = RECEIPT.pullRequest.head;
const B0 = RECEIPT.pullRequest.base;
const H1 = RECORD.target.head!;
const TIP = RECORD.target.base;

/** The reviewed patch as GitHub's Git trees give it. */
const CHANGES: readonly HostedTreeChangeV1[] = [{
  path: "src/lithos-health.ts",
  oldMode: "100644",
  oldSha: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  newMode: "100644",
  newSha: "b0202a10adc703792bff95ca0e1c0d9683fd3f61",
}];

/** The live merged pull, closed source issue and the two trees. */
function carriedSurface(
  github: HostedAutonomyGitHubV1,
  refreshed: readonly HostedTreeChangeV1[],
) {
  const trees: string[] = [];
  const surface: HostedAutonomyGitHubV1 = {
    ...github,
    readPull: (number) =>
      Promise.resolve(
        LIVE_PULLS.find((pull) => pull.number === number) ?? null,
      ),
    readIssueTask: async (number) => {
      const task = LIVE_TASKS.find((item) => item.issueNumber === number);
      return task === undefined
        ? null
        : { ...task, digest: await reviewTaskStatementDigest(task) };
    },
    readIssueOptedOut: () => Promise.resolve(false),
    mergeBaseTreeChanges: (base: string, head: string) => {
      trees.push(`${base}...${head}`);
      if (base === B0 && head === H0) {
        return Promise.resolve({ mergeBase: B0, changes: CHANGES });
      }
      if (base === TIP && head === H1) {
        return Promise.resolve({ mergeBase: TIP, changes: refreshed });
      }
      return Promise.resolve(null);
    },
  };
  return { surface, trees };
}

/** The release path enabled: the real VPS controller accepts 618's request. */
async function acceptedRig(name: string) {
  const { rig, github } = await makeRig(`carried-release-${name}`, {
    releaseReadThrough: true,
    repair: parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: LIVE_UPDATED_AT,
      incidents: [],
      evidence: [],
      work: [RECORD],
      reservations: [],
      reviews: [RECEIPT],
      replays: [],
      releaseRequests: [REQUEST],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }),
    issueOpen: false,
    defaultBranch: "development",
  });
  const release = createReleaseStateStore({
    remoteUrl: `${rig.tmp}/remote.git`,
    scratchDir: `${rig.tmp}/vps-release`,
  });
  let now = NOW;
  await persistVpsDelivery(
    rig.state,
    release,
    {
      now: () => now,
      advance: (ms) => {
        now += ms;
      },
    },
    REQUEST,
    "accepted",
  );
  return { rig, github, now };
}

async function snapshot(
  state: Awaited<ReturnType<typeof makeRig>>["rig"]["state"],
) {
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  return read.value.snapshot;
}

historicalTest(
  "carried release (launcher): an accepted carried Gateway delivery is closed once the tree proof holds",
  async (runHostedAutonomy) => {
    // The live shape: the exact binder refuses it, as before.
    assert.equal(H0 === H1, false);
    assert.equal(
      await gatewayRequestBindsDelivery(REQUEST, RECORD, RECEIPT),
      false,
    );
    const { rig, github, now } = await acceptedRig("closed");
    try {
      const { surface, trees } = carriedSurface(github, CHANGES);
      const pass = async (offset: number) =>
        runHostedAutonomy(
          await withHistoricalQueueAuthority({
            state: rig.state,
            githubFor: () => surface,
            clock: { now: () => now + offset },
          }),
        );
      const first = await pass(300_000);
      assert.ok(
        first.actions.includes(`intent:${RECORD.id}:issue_closure`),
        JSON.stringify(first.actions),
      );
      const intent = (await snapshot(rig.state)).work[0].intent;
      assert.equal(intent?.kind, "issue_closure");
      assert.equal(intent?.requestId, REQUEST.id);
      assert.equal(intent?.expectedHead, H1);
      assert.equal(intent?.observedBase, TIP);
      const second = await pass(600_000);
      assert.ok(
        second.actions.includes(`reconcile:${RECORD.id}:already_closed`),
        JSON.stringify(second.actions),
      );
      const after = await snapshot(rig.state);
      assert.equal(after.work[0].nextStep, "done");
      assert.deepEqual(after.work[0].target, RECORD.target);
      assert.deepEqual(after.releaseRequests, [REQUEST]);
      // The tree proof was re-derived: H0 on B0 against H1 on T.
      assert.ok(trees.includes(`${B0}...${H0}`), JSON.stringify(trees));
      assert.ok(trees.includes(`${TIP}...${H1}`), JSON.stringify(trees));
      // The platform already closed the issue: no duplicate close, no merge.
      assert.deepEqual(rig.closed, []);
      assert.equal(rig.merges, 0);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

historicalTest(
  "carried release (launcher): an accepted carried Gateway request whose patch no longer proves is refused",
  async (runHostedAutonomy) => {
    const { rig, github, now } = await acceptedRig("refused");
    try {
      // The refreshed side changed one more path (a base change touching
      // the reviewed patch): no proof, so nothing is accepted or closed.
      const { surface, trees } = carriedSurface(github, [...CHANGES, {
        path: "src/other.ts",
        oldMode: "100644",
        oldSha: "c".repeat(40),
        newMode: "100644",
        newSha: "d".repeat(40),
      }]);
      // The queue custody's own delivery proof still sees the proving trees,
      // so only the closure gate's re-derived tree proof can refuse.
      const custodyDeps = {
        state: rig.state,
        githubFor: () => carriedSurface(github, CHANGES).surface,
      };
      const custody = historicalDarkQueueFixture(custodyDeps);
      const queue = await darkQueueCoordinatorFixture(custodyDeps, custody);
      const before = await snapshot(rig.state);
      for (const offset of [300_000, 600_000]) {
        const result = await runHostedAutonomy({
          state: rig.state,
          githubFor: () => surface,
          clock: { now: () => now + offset },
          queueCustody: custody,
          queue,
        });
        assert.ok(
          result.actions.includes(`delivery:${RECORD.id}:release_unavailable`),
          JSON.stringify(result.actions),
        );
        assert.equal(
          result.actions.some((action) =>
            action.startsWith(`intent:${RECORD.id}`) ||
            action.startsWith(`reconcile:${RECORD.id}`) ||
            action.startsWith(`close:${RECORD.id}`)
          ),
          false,
          JSON.stringify(result.actions),
        );
      }
      assert.ok(trees.includes(`${TIP}...${H1}`), JSON.stringify(trees));
      const after = await snapshot(rig.state);
      assert.equal(after.sequence, before.sequence);
      assert.equal(after.work[0].nextStep, "delivery");
      assert.equal(after.work[0].intent, null);
      assert.deepEqual(rig.closed, []);
      assert.equal(rig.merges, 0);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

Deno.test("carried release (launcher): the tree prover is the pass's one proof and the carried authorization is the reviewed identity's", async () => {
  const { surface: proving, trees } = carriedSurface(
    {} as HostedAutonomyGitHubV1,
    CHANGES,
  );
  const pass = {};
  const prover = treeCarriedReleaseProver(pass, proving, RECEIPT);
  assert.equal(
    await carriedGatewayRequestBindsDelivery(REQUEST, RECORD, RECEIPT, prover),
    true,
  );
  // Derived once per pass, however often the gate asks.
  assert.equal(
    await carriedGatewayRequestBindsDelivery(
      REQUEST,
      RECORD,
      RECEIPT,
      treeCarriedReleaseProver(pass, proving, RECEIPT),
    ),
    true,
  );
  assert.deepEqual(trees, [`${B0}...${H0}`, `${TIP}...${H1}`]);
  // Another pass derives it again; a changed or unreadable tree refuses.
  const { surface: changed } = carriedSurface({} as HostedAutonomyGitHubV1, []);
  assert.equal(
    await carriedGatewayRequestBindsDelivery(
      REQUEST,
      RECORD,
      RECEIPT,
      treeCarriedReleaseProver({}, changed, RECEIPT),
    ),
    false,
  );
  assert.equal(
    await carriedGatewayRequestBindsDelivery(
      REQUEST,
      RECORD,
      RECEIPT,
      treeCarriedReleaseProver({}, null, RECEIPT),
    ),
    false,
  );
  // The task is authorized as of H0 on B0 for the carried record only.
  const statement = async (issueNumber: number) => {
    const task = LIVE_TASKS.find((item) => item.issueNumber === issueNumber)!;
    return { ...task, digest: await reviewTaskStatementDigest(task) };
  };
  const repair = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: LIVE_UPDATED_AT,
    incidents: [],
    evidence: [],
    work: [...LIVE_RECORDS],
    reservations: [],
    reviews: [...LIVE_REVIEWS],
    replays: [],
    releaseRequests: [...LIVE_REQUESTS],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const task = await statement(618);
  assert.equal(authorizingReceipt(repair, RECORD, task), null);
  assert.deepEqual(releaseAuthorizingReceipt(repair, RECORD, task), RECEIPT);
  assert.equal(
    releaseAuthorizingReceipt(repair, { ...RECORD, nextStep: "work" }, task),
    null,
  );
  assert.equal(releaseAuthorizingReceipt(repair, RECORD, "unavailable"), null);
  // The exact (non-carried) 670 keeps the exact authorization.
  const exact = LIVE_RECORDS.find((record) =>
    record.related.issueNumber === 670
  )!;
  const exactTask = await statement(670);
  assert.notEqual(authorizingReceipt(repair, exact, exactTask), null);
  assert.deepEqual(
    releaseAuthorizingReceipt(repair, exact, exactTask),
    authorizingReceipt(repair, exact, exactTask),
  );
});
