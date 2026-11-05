/**
 * Post-merge delivery gate (sentinel #337): a merged foreign pull request
 * closes its issue only once the target's trusted `requiredForDelivery`
 * checks on the merge commit are green.
 */
import assert from "node:assert/strict";

import type { HostedDeliveryCheckV1 } from "../../ops/hosted-autonomy-types.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy.ts";
import {
  decideDeliveryChecks,
  DELIVERY_CHECK_FAILED_PREFIX,
  DELIVERY_CHECK_TIMEOUT_PREFIX,
  DELIVERY_CHECK_WAIT_MS,
} from "../../ops/hosted-autonomy-delivery-checks.ts";
import {
  parseDeliveryCheckRun,
  parseDeliveryCommitStatus,
} from "../../ops/hosted-autonomy-github-delivery.ts";
import {
  parseRequiredForDeliveryV1,
  targetDeliveryCheckPolicyV1,
} from "../../src/host/target-delivery-checks.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import {
  FOREIGN_REPO,
  FOREIGN_TARGET,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
  MERGE,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";

const NOW = T0 + 5_000_000;
const DEPLOY = "deploy-router";

function check(
  overrides: Partial<HostedDeliveryCheckV1> = {},
): HostedDeliveryCheckV1 {
  return {
    name: DEPLOY,
    status: "completed",
    conclusion: "success",
    id: 98765432101,
    startedAt: NOW - 60_000,
    ...overrides,
  };
}

async function deliveryRig(
  prefix: string,
  checks: () => readonly HostedDeliveryCheckV1[] | null,
  withReader = true,
) {
  const { rig, github } = await makeRig(prefix, {
    repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
    pull: foreignPullFacts({
      parents: [SHA1, HEAD],
      baseAncestorOfRevision: true,
    }),
  });
  const comments: { issue: number; body: string }[] = [];
  const reads: string[] = [];
  const surface: HostedAutonomyGitHubV1 = {
    ...github,
    ...(withReader
      ? {
        readDeliveryChecks: (commit: string) => {
          reads.push(commit);
          return Promise.resolve(checks());
        },
      }
      : {}),
    commentIssue: (issue: number, body: string) => {
      comments.push({ issue, body });
      return Promise.resolve(true);
    },
  };
  rig.githubFor = () => surface;
  return { rig, comments, reads };
}

async function record(rig: Awaited<ReturnType<typeof makeRig>>["rig"]) {
  const read = await rig.state.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("unreadable");
  return read.value.snapshot.work.find((row) => row.id === FOREIGN_TARGET)!;
}

const policy = (names: readonly string[]) => ({
  requiredForDelivery: () => names,
});

Deno.test("delivery checks: a failed delivery check parks the record, keeps the issue open and comments once", async () => {
  let current = [check({ conclusion: "failure" })];
  const { rig, comments, reads } = await deliveryRig(
    "delivery-failed",
    () => current,
  );
  try {
    const result = await run(rig, undefined, policy([DEPLOY]));
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.deepEqual(rig.closed, []);
    assert.deepEqual(reads, [MERGE]);
    const parked = await record(rig);
    assert.equal(parked.nextStep, "blocked");
    assert.equal(parked.blocker?.kind, "other");
    assert.ok(
      parked.blocker?.message.startsWith(
        `${DELIVERY_CHECK_FAILED_PREFIX}: ${DEPLOY} (failure) id 98765432101`,
      ),
      parked.blocker?.message,
    );
    assert.ok(
      result.actions.includes(
        `delivery-checks:${FOREIGN_TARGET}:failed:${DEPLOY}:failure:id=98765432101`,
      ),
      JSON.stringify(result.actions),
    );
    assert.equal(comments.length, 1);
    assert.equal(comments[0].issue, 120);
    assert.ok(comments[0].body.includes("<!-- sentinel:progress "));
    assert.ok(comments[0].body.includes("98765432101"));
    // An unchanged park is neither rewritten nor commented again.
    const writes = rig.writes;
    await run(rig, undefined, policy([DEPLOY]));
    assert.equal(comments.length, 1);
    assert.equal(rig.writes, writes);
    assert.deepEqual(rig.closed, []);
    assert.equal((await record(rig)).nextStep, "blocked");
    // A green rerun of the delivery check closes from the park.
    current = [
      check({ conclusion: "failure" }),
      check({ id: 98765432102, startedAt: NOW - 1000 }),
    ];
    const closed = await run(rig, undefined, policy([DEPLOY]));
    assert.equal(closed.reason, "closed_issues", JSON.stringify(closed));
    assert.deepEqual(rig.closed, [120]);
    assert.equal((await record(rig)).nextStep, "done");
    assert.equal(comments.length, 1);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("delivery checks: a passing delivery check closes the issue and records the receipt", async () => {
  const { rig, comments } = await deliveryRig(
    "delivery-passed",
    () => [check(), check({ name: "unrelated", conclusion: "failure", id: 7 })],
  );
  try {
    const result = await run(rig, undefined, policy([DEPLOY]));
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "closed_issues");
    assert.deepEqual(rig.closed, [120]);
    assert.equal((await record(rig)).nextStep, "done");
    assert.ok(
      result.actions.includes(
        `delivery-checks:${FOREIGN_TARGET}:passed:${DEPLOY}=success@98765432101`,
      ),
      JSON.stringify(result.actions),
    );
    assert.deepEqual(comments, []);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("delivery checks: a pending delivery check waits on `deployment` with a deadline, then parks", async () => {
  const started = NOW - 120_000;
  const { rig, comments } = await deliveryRig(
    "delivery-pending",
    () => [
      check({ status: "in_progress", conclusion: null, startedAt: started }),
    ],
  );
  try {
    const result = await run(rig, undefined, policy([DEPLOY]));
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.deepEqual(rig.closed, []);
    const waiting = await record(rig);
    assert.equal(waiting.nextStep, "delivery");
    assert.deepEqual(waiting.wait, {
      reason: "deployment",
      since: started,
      until: started + DELIVERY_CHECK_WAIT_MS,
    });
    // Still pending inside the bound: no further write.
    const writes = rig.writes;
    const again = await run(rig, undefined, {
      ...policy([DEPLOY]),
      clock: { now: () => NOW + 60_000 },
    });
    assert.notEqual(again.status, "failed", JSON.stringify(again));
    assert.equal(rig.writes, writes);
    assert.equal((await record(rig)).nextStep, "delivery");
    // Past the deadline the still-incomplete check parks the record.
    await run(rig, undefined, {
      ...policy([DEPLOY]),
      clock: { now: () => started + DELIVERY_CHECK_WAIT_MS + 1 },
    });
    const parked = await record(rig);
    assert.equal(parked.nextStep, "blocked");
    assert.ok(
      parked.blocker?.message.startsWith(
        `${DELIVERY_CHECK_TIMEOUT_PREFIX}: ${DEPLOY} (in_progress)`,
      ),
      parked.blocker?.message,
    );
    assert.equal(comments.length, 1);
    assert.deepEqual(rig.closed, []);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("delivery checks: an empty policy keeps the existing closure unchanged", async () => {
  const { rig, reads } = await deliveryRig(
    "delivery-empty",
    () => [check({ conclusion: "failure" })],
  );
  try {
    const result = await run(rig, undefined, policy([]));
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "closed_issues");
    assert.deepEqual(rig.closed, [120]);
    assert.deepEqual(reads, []);
    assert.equal((await record(rig)).nextStep, "done");
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
  // The production default for an unlisted target is empty as well.
  assert.deepEqual(
    targetDeliveryCheckPolicyV1(FOREIGN_REPO).requiredForDelivery,
    [],
  );
});

Deno.test("delivery checks: an unreadable listing or a surface without the read never closes", async () => {
  for (
    const [prefix, withReader] of [["unreadable", true], [
      "absent",
      false,
    ]] as const
  ) {
    const { rig } = await deliveryRig(
      `delivery-${prefix}`,
      () => null,
      withReader,
    );
    try {
      await run(rig, undefined, policy([DEPLOY]));
      assert.deepEqual(rig.closed, []);
      const row = await record(rig);
      assert.equal(row.nextStep, "delivery");
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  }
});

Deno.test("delivery checks: decision judges the latest run per name and failures before pending", () => {
  const rerun = decideDeliveryChecks(
    [DEPLOY],
    [
      check({ conclusion: "failure", id: 1, startedAt: NOW - 50_000 }),
      check({ conclusion: "success", id: 2, startedAt: NOW - 10_000 }),
    ],
    MERGE,
    null,
    NOW,
  );
  assert.deepEqual(rerun, {
    kind: "proceed",
    receipt: [{ name: DEPLOY, conclusion: "success", id: 2 }],
  });
  const masked = decideDeliveryChecks(
    ["queued", DEPLOY],
    [
      check({ name: "queued", status: "queued", conclusion: null, id: 3 }),
      check({ conclusion: "timed_out", id: 4 }),
    ],
    MERGE,
    null,
    NOW,
  );
  assert.equal(masked.kind, "blocked");
  const missing = decideDeliveryChecks([DEPLOY], [], MERGE, NOW - 1000, NOW);
  assert.deepEqual(missing, {
    kind: "wait",
    pending: [DEPLOY],
    since: NOW - 1000,
    until: NOW - 1000 + DELIVERY_CHECK_WAIT_MS,
  });
});

Deno.test("delivery checks: commit statuses and check runs parse strictly; policy names parse strictly", () => {
  assert.deepEqual(
    parseDeliveryCommitStatus({
      id: 5,
      context: "Cloudflare Pages",
      state: "error",
      created_at: "2026-11-01T00:00:00Z",
    }),
    {
      name: "Cloudflare Pages",
      status: "completed",
      conclusion: "failure",
      id: 5,
      startedAt: Date.parse("2026-11-01T00:00:00Z"),
    },
  );
  assert.equal(
    parseDeliveryCommitStatus({ id: 5, context: "x", state: "weird" }),
    null,
  );
  assert.equal(
    parseDeliveryCheckRun(
      {
        id: 1,
        name: DEPLOY,
        status: "completed",
        conclusion: "success",
        head_sha: HEAD,
      },
      MERGE,
    ),
    null,
  );
  assert.deepEqual(parseRequiredForDeliveryV1(undefined), []);
  assert.deepEqual(parseRequiredForDeliveryV1([DEPLOY]), [DEPLOY]);
  assert.throws(() => parseRequiredForDeliveryV1([DEPLOY, "Deploy-Router"]));
  assert.throws(() => parseRequiredForDeliveryV1([" padded"]));
  assert.throws(() => parseRequiredForDeliveryV1("deploy"));
});
