/**
 * JAM B12, launcher half: the closure-delivery pass ran the full Gateway
 * closure gate (source task, opt-out, pull and two release reads) for every
 * merged ai.ubq.fi delivery on every pass and printed one
 * `delivery:<id>:release_unavailable` line each (25 per live pass), although
 * with no VPS release record for the request the gate can only ever answer
 * `wait`. Such a delivery is now counted in ONE summary line, nothing is read
 * or written for it, and the full gate runs again for a request the release
 * ref records. Live record, request and receipt shapes.
 */
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import assert from "node:assert/strict";
import { makeRig } from "./hosted-autonomy-rig.ts";
import {
  deferredLiveRecords,
  LIVE_LAUNCHER,
  LIVE_PULLS,
  LIVE_RECORDS,
  LIVE_REQUESTS,
  LIVE_REVIEWS,
  LIVE_TASKS,
  LIVE_UPDATED_AT,
  loadRevisionModules,
  revisionAvailable,
} from "../repair/release-deferred-fixtures.ts";
import { persistVpsDelivery } from "../repair/vps-delivery-fixtures.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";

/** Preserve B12's historical closure gate under explicit preactivation policy. */
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

/** The R80 shape (live, five-minute waits) and the new deferred shape. */
const SHAPES: readonly (readonly [string, readonly WorkRecordV1[]])[] = [
  ["R80 re-armed wait", LIVE_RECORDS],
  ["deferred wait", deferredLiveRecords(LIVE_UPDATED_AT)],
];

function liveRepair(work: readonly WorkRecordV1[] = LIVE_RECORDS) {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: LIVE_UPDATED_AT,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: LIVE_REVIEWS,
    replays: [],
    releaseRequests: LIVE_REQUESTS,
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

/**
 * The live GitHub facts (merged pull, closed issue with its exact reviewed
 * statement), counting every read the closure gate spends on them.
 */
function countingSurface(github: HostedAutonomyGitHubV1) {
  const reads: string[] = [];
  const surface: HostedAutonomyGitHubV1 = {
    ...github,
    readPull: (number) => {
      reads.push(`pull:${number}`);
      return Promise.resolve(
        LIVE_PULLS.find((pull) => pull.number === number) ?? null,
      );
    },
    readIssueTask: async (number) => {
      reads.push(`task:${number}`);
      const task = LIVE_TASKS.find((item) => item.issueNumber === number);
      return task === undefined
        ? null
        : { ...task, digest: await reviewTaskStatementDigest(task) };
    },
    readIssueOptedOut: (number) => {
      reads.push(`optout:${number}`);
      return Promise.resolve(false);
    },
  };
  return { surface, reads };
}

async function sequence(
  state: Awaited<ReturnType<typeof makeRig>>["rig"]["state"],
) {
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  return read.value.snapshot.sequence;
}

historicalTest(
  "B12 launcher: merged Gateway deliveries without a release record are counted once and cost no gate read",
  async (runHostedAutonomy) => {
    for (const [shape, work] of SHAPES) {
      await deferredPasses(runHostedAutonomy, shape, work);
    }
  },
);

async function deferredPasses(
  runHostedAutonomy: HistoricalRunner,
  shape: string,
  work: readonly WorkRecordV1[],
) {
  const { rig, github } = await makeRig("b12-launcher-deferred", {
    repair: liveRepair(work),
    issueOpen: false,
    defaultBranch: "development",
  });
  try {
    const { surface, reads } = countingSurface(github);
    const before = await sequence(rig.state);
    for (let pass = 0; pass < 3; pass++) {
      const result = await runHostedAutonomy(
        await withDarkQueueAuthority({
          state: rig.state,
          githubFor: () => surface,
          clock: { now: () => NOW + pass * 300_000 },
        }),
      );
      assert.deepEqual(
        result.actions.filter((action) => action.startsWith("release-")),
        ["release-deferred:count=3:release_path=disabled"],
        `${shape}: ${JSON.stringify(result.actions)}`,
      );
      for (const record of LIVE_RECORDS) {
        assert.equal(
          result.actions.some((action) =>
            action === `delivery:${record.id}:release_unavailable`
          ),
          false,
          record.id,
        );
      }
    }
    // The closure gate's own reads (pull, opt-out) never ran for them.
    assert.deepEqual(
      reads.filter((read) => !read.startsWith("task:")),
      [],
    );
    assert.equal(await sequence(rig.state), before, shape);
    assert.deepEqual(rig.closed, []);
    assert.equal(rig.merges, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

historicalTest(
  "B12 launcher: a request the release ref records gets the full closure gate again",
  async (runHostedAutonomy) => {
    const { rig, github, request, now } = await recordedRig("monitoring");
    try {
      const { surface, reads } = countingSurface(github);
      const result = await runHostedAutonomy(
        await withDarkQueueAuthority({
          state: rig.state,
          githubFor: () => surface,
          clock: { now: () => now + 300_000 },
        }),
      );
      assert.deepEqual(
        result.actions.filter((action) => action.startsWith("release-")),
        ["release-deferred:count=2:release_path=queued"],
        JSON.stringify(result.actions),
      );
      const resumed = recordFor(request);
      assert.ok(
        result.actions.includes(`delivery:${resumed.id}:release_unavailable`),
        JSON.stringify(result.actions),
      );
      assert.ok(reads.includes(`pull:${resumed.target.pr}`));
      for (const record of LIVE_RECORDS) {
        if (record.id === resumed.id) continue;
        assert.equal(reads.includes(`pull:${record.target.pr}`), false);
      }
      assert.deepEqual(rig.closed, []);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

historicalTest(
  "B12 launcher: an accepted release closes out a record the runtime left deferred, so the obligation survives any runtime",
  async (runHostedAutonomy) => {
    const { rig, github, request, now } = await recordedRig(
      "accepted",
      deferredLiveRecords(LIVE_UPDATED_AT),
    );
    try {
      const { surface } = countingSurface(github);
      const resumed = recordFor(request);
      const pass = async (offset: number) =>
        runHostedAutonomy(
          await withDarkQueueAuthority({
            state: rig.state,
            githubFor: () => surface,
            clock: { now: () => now + offset },
          }),
        );
      const first = await pass(300_000);
      assert.ok(
        first.actions.includes(`intent:${resumed.id}:issue_closure`),
        JSON.stringify(first.actions),
      );
      const second = await pass(600_000);
      assert.ok(
        second.actions.includes(`reconcile:${resumed.id}:already_closed`),
        JSON.stringify(second.actions),
      );
      const read = await rig.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const after = read.value.snapshot;
      for (const record of after.work) {
        if (record.id === resumed.id) {
          assert.equal(record.nextStep, "done");
          assert.equal(record.wait, null);
        } else {
          assert.equal(record.nextStep, "delivery", record.id);
          assert.equal(record.wait?.until, null, record.id);
        }
      }
      assert.equal(after.releaseRequests.length, LIVE_REQUESTS.length);
      // The platform already closed the issue: no duplicate close, no merge.
      assert.deepEqual(rig.closed, []);
      assert.equal(rig.merges, 0);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

/** The record a live request belongs to. */
function recordFor(request: (typeof LIVE_REQUESTS)[number]): WorkRecordV1 {
  return LIVE_RECORDS.find((record) =>
    record.target.pr === request.source.pullRequest
  )!;
}

/**
 * The release path enabled: the real VPS controller begins the oldest open
 * request (670's) and drives it to `phase` on the rig's release ref.
 */
async function recordedRig(
  phase: "monitoring" | "accepted",
  work: readonly WorkRecordV1[] = LIVE_RECORDS,
) {
  const { rig, github } = await makeRig(`b12-launcher-${phase}`, {
    repair: liveRepair(work),
    issueOpen: false,
    defaultBranch: "development",
  });
  const release = createReleaseStateStore({
    remoteUrl: `${rig.tmp}/remote.git`,
    scratchDir: `${rig.tmp}/vps-release`,
  });
  let now = NOW;
  const request =
    [...LIVE_REQUESTS].sort((a, b) => a.createdAt - b.createdAt)[0];
  await persistVpsDelivery(
    rig.state,
    release,
    {
      now: () => now,
      advance: (ms) => {
        now += ms;
      },
    },
    request,
    phase,
  );
  return { rig, github, request, now };
}

Deno.test({
  name:
    "B12 launcher rollback: the live launcher reads the deferred shape as before and writes nothing",
  ignore: !await revisionAvailable(LIVE_LAUNCHER),
  fn: async () => {
    const loaded = await loadRevisionModules(
      LIVE_LAUNCHER,
      ["ops/hosted-autonomy-runner.ts"],
      true,
    );
    const [runner] = loaded.modules as [
      typeof import("../../ops/hosted-autonomy-runner.ts"),
    ];
    const { rig, github } = await makeRig("b12-launcher-rollback", {
      repair: liveRepair(deferredLiveRecords(LIVE_UPDATED_AT)),
      issueOpen: false,
      defaultBranch: "development",
    });
    try {
      const { surface } = countingSurface(github);
      const before = await sequence(rig.state);
      for (const pass of [0, 1]) {
        const rolled = await runner.runHostedAutonomy({
          state: rig.state,
          githubFor: () => surface,
          clock: { now: () => NOW + pass * 300_000 },
        });
        // Its own per-record report, exactly as on R80's re-armed waits (670
        // is the record whose live source statement the fixture carries).
        assert.ok(
          rolled.actions.includes(
            "delivery:issue-ubiquity-ai.ubq.fi-670:release_unavailable",
          ),
          JSON.stringify(rolled.actions),
        );
      }
      assert.equal(await sequence(rig.state), before);
      assert.deepEqual(rig.closed, []);
    } finally {
      await loaded.dispose();
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
});
