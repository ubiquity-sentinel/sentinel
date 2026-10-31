/**
 * Owner directive 2026-10-31: for an issue-repair target whose release path is
 * disabled (`sentinel-release` stays disabled), acceptance ends at the merge,
 * so a merged PR completes its delivery record instead of waiting forever for
 * a VPS release record the disabled controller never writes. The completion is
 * only ever the exact recorded merge SHA; with the release path enabled the
 * previous deferral and VPS acceptance remain.
 */
import assert from "node:assert/strict";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import { gatewayLoopDelivery } from "./vps-delivery-fixtures.ts";
import { releaseWithoutVps } from "./release-deferred-fixtures.ts";
import { REPO, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseVpsReleaseRecordV1 } from "../../src/contracts/vps-release.ts";

const PR = 12;

/** The fixture PR positively read as merged at the request's exact revision. */
const mergedPullRequest = {
  prNumber: PR,
  pullRequest: {
    number: PR,
    state: "merged" as const,
    head: SHA1,
    base: SHA2,
    mergeSha: SHA3,
    mergedAt: T0,
  },
};

const blueprint = parseVpsReleaseRecordV1(JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/vps/release-requested-v1.json", import.meta.url),
  ),
));

/** Release ref with one VPS record for another request: path enabled. */
function releasePathEnabled() {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    vpsReleases: [blueprint],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  });
}

/** The live JAM B12 deferred shape selection skips (wait.until null). */
function deferredShape(record: WorkRecordV1): WorkRecordV1 {
  return parseWorkRecordV1({
    ...record,
    wait: { reason: "unavailable", since: T0, until: null },
  });
}

async function seededRig(
  prefix: string,
  release: unknown,
  shape: (record: WorkRecordV1) => WorkRecordV1 = (record) => record,
) {
  const rig = await makeRig(prefix, {
    summaries: false,
    github: mergedPullRequest,
    configOverrides: { repository: REPO },
  });
  const written = await rig.releaseStore.writeRelease(release as never, null);
  assert.ok(written.ok && written.value.status === "applied");
  const { record: initial, request, review } = await gatewayLoopDelivery();
  const record = shape(initial);
  const seed = await rig.store.writeRepair(
    seededSnapshot([record], {
      releaseRequests: [request],
      reviews: [review],
    }),
    null,
  );
  assert.ok(seed.ok && seed.value.status === "applied");
  return { rig, record, request };
}

Deno.test("release path disabled + merged PR: delivery completes to done with merge-accepted evidence", async () => {
  const { rig, record, request } = await seededRig(
    "merge-accepted-disabled",
    releaseWithoutVps(T0),
  );
  try {
    await rig.entry();
    const after = await rig.snapshot();
    const done = after.work[0];
    assert.equal(done.nextStep, "done");
    assert.equal(done.wait, null);
    assert.equal(done.intent, null);
    assert.equal(done.blocker, null);
    const evidence = done.evidence.filter((item) =>
      item.ref.startsWith("artifact:delivery/")
    );
    assert.deepEqual(evidence, [{
      kind: "review_receipt",
      ref:
        `artifact:delivery/merge-accepted-release-disabled/${PR}/${request.revision}`,
    }]);
    // The release request is bookkeeping only: unchanged, never observed as
    // delivered by a release record, and no release/GitHub write is spent.
    assert.deepEqual(after.releaseRequests, [request]);
    assert.deepEqual(after.reservations, []);
    assert.equal(
      rig.github.calls.some((call) =>
        call.startsWith("closeIssue") || call.startsWith("merge")
      ),
      false,
    );
    assert.equal(record.target.pr, PR);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("release path enabled + merged PR: delivery still defers to VPS acceptance", async () => {
  const { rig, record } = await seededRig(
    "merge-accepted-enabled",
    releasePathEnabled(),
  );
  try {
    await rig.entry();
    const after = (await rig.snapshot()).work[0];
    assert.equal(after.nextStep, "delivery");
    assert.equal(after.intent, null);
    assert.equal(after.blocker, null);
    assert.deepEqual(after.wait, {
      reason: "unavailable",
      since: T0,
      until: null,
    });
    assert.deepEqual(after.evidence, record.evidence);
    // The enabled path never spends the merge read: VPS acceptance decides.
    assert.equal(
      rig.github.calls.some((call) => call.startsWith(`readPr:${PR}`)),
      false,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("release path disabled + already-deferred record + merged PR: the next cycle completes it", async () => {
  const { rig, request, record } = await seededRig(
    "merge-accepted-deferred-disabled",
    releaseWithoutVps(T0),
    deferredShape,
  );
  try {
    await rig.entry();
    const done = (await rig.snapshot()).work[0];
    assert.equal(done.nextStep, "done");
    assert.equal(done.wait, null);
    assert.equal(done.intent, null);
    assert.equal(done.blocker, null);
    assert.deepEqual(
      done.evidence.filter((item) => item.ref.startsWith("artifact:delivery/")),
      [{
        kind: "review_receipt",
        ref:
          `artifact:delivery/merge-accepted-release-disabled/${PR}/${request.revision}`,
      }],
    );
    // The resume pass (deferred records are skipped by selection) spent the
    // exact merge read and no GitHub write; provenance keeps the source issue.
    assert.equal(
      rig.github.calls.filter((call) => call === `readPr:${PR}`).length,
      1,
    );
    assert.equal(
      rig.github.calls.some((call) =>
        call.startsWith("closeIssue") || call.startsWith("merge")
      ),
      false,
    );
    assert.deepEqual(done.target, record.target);
    assert.deepEqual(done.related, record.related);
    assert.deepEqual((await rig.snapshot()).releaseRequests, [request]);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("release path enabled + already-deferred record + merged PR: stays deferred for VPS acceptance", async () => {
  const { rig, record } = await seededRig(
    "merge-accepted-deferred-enabled",
    releasePathEnabled(),
    deferredShape,
  );
  try {
    await rig.entry();
    const after = (await rig.snapshot()).work[0];
    assert.equal(after.nextStep, "delivery");
    assert.equal(after.intent, null);
    assert.equal(after.blocker, null);
    assert.deepEqual(after.wait, {
      reason: "unavailable",
      since: T0,
      until: null,
    });
    assert.deepEqual(after.evidence, record.evidence);
    assert.equal(
      rig.github.calls.some((call) => call.startsWith(`readPr:${PR}`)),
      false,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
