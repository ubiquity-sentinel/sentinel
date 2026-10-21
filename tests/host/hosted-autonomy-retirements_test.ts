import { SHA1 as ATTEMPT_RUNTIME } from "../state/helpers.ts";
import assert from "node:assert/strict";
import {
  createHostedAutonomyGitHub,
  HOSTED_AUTONOMY_RETIRED,
  parseHostedAutonomyPull,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy.ts";
import { T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  blockedZombie,
  deliveryRecord,
  HEAD,
  MERGE,
  pullFacts,
  SELF_REPO,
  TARGET,
  ZOMBIE,
  zombieCharges,
  zombieIntent,
  zombieRecord,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";

Deno.test(
  "hosted autonomy: an unmerged pull parses without a merge commit and a merged pull still resolves",
  async () => {
    const live = parseHostedAutonomyPull({
      state: "open",
      merged: false,
      merge_commit_sha: null,
      head: { sha: HEAD },
      base: { ref: "development" },
      user: { login: "github-actions[bot]" },
      number: 63,
    });
    assert.deepEqual(live, {
      number: 63,
      state: "open",
      merged: false,
      mergeCommitSha: null,
      headSha: HEAD,
      baseRef: "development",
      baseSha: null,
      author: "github-actions[bot]",
      parents: [],
      revisionOnBaseBranch: false,
      baseAncestorOfRevision: false,
    });
    const merged = parseHostedAutonomyPull({
      state: "closed",
      merged: true,
      merge_commit_sha: MERGE,
      head: { sha: HEAD },
      base: { ref: "development" },
      user: { login: "github-actions[bot]" },
      number: 51,
      merged_by: { login: "ubiquity-sentinel[bot]" },
    });
    assert.equal(merged?.merged, true);
    assert.equal(merged?.mergeCommitSha, MERGE);
    assert.equal(merged?.headSha, HEAD);
    assert.equal(merged?.baseRef, "development");
    assert.equal(merged?.mergedBy, "ubiquity-sentinel[bot]");
    // A merged pull must still name the merge commit it was merged as.
    assert.equal(
      parseHostedAutonomyPull({
        state: "closed",
        merged: true,
        merge_commit_sha: null,
        head: { sha: HEAD },
        base: { ref: "development" },
        user: { login: "github-actions[bot]" },
        number: 51,
      }),
      null,
    );

    const original = globalThis.fetch;
    const requests: string[] = [];
    let integrationCompareBytes = 0;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const payload = url.includes("/pulls/63")
        ? {
          state: "open",
          merged: false,
          merge_commit_sha: null,
          head: { sha: HEAD },
          base: { ref: "development" },
          user: { login: "github-actions[bot]" },
          number: 63,
        }
        : url.includes("/pulls/51")
        ? {
          state: "closed",
          merged: true,
          merge_commit_sha: MERGE,
          head: { sha: HEAD },
          base: { ref: "development", sha: BASE },
          user: { login: "github-actions[bot]" },
          number: 51,
        }
        : url.includes("/commits/")
        ? { parents: [{ sha: BASE }, { sha: HEAD }] }
        : url.includes(`/compare/${BASE}...`)
        ? {
          status: "ahead",
          base_commit: { sha: BASE },
          merge_base_commit: { sha: BASE },
        }
        : (() => {
          // A real integration compare embeds the whole commit/file gap and
          // can exceed the ordinary 1 MiB response bound (2026-10-05 stacked
          // merges: ~1.9 MB). It must still be read.
          const payload = {
            status: "ahead",
            base_commit: { sha: MERGE },
            merge_base_commit: { sha: MERGE },
            files: Array.from({ length: 4000 }, () => ({
              filename: "p".repeat(300),
            })),
          };
          integrationCompareBytes = JSON.stringify(payload).length;
          return payload;
        })();
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    }) as typeof fetch;
    try {
      const github = createHostedAutonomyGitHub("fixture-token", SELF_REPO);
      const unmerged = await github.readPull(63, "development");
      assert.equal(unmerged?.state, "open");
      assert.equal(unmerged?.merged, false);
      assert.equal(unmerged?.mergeCommitSha, null);
      assert.equal(unmerged?.headSha, HEAD);
      assert.equal(unmerged?.baseRef, "development");
      assert.equal(unmerged?.author, "github-actions[bot]");
      assert.equal(requests.length, 1);
      assert.ok(
        requests[0].includes("/repos/Ubiquity-Sentinel/sentinel/pulls/63"),
      );

      const afterMerge = await github.readPull(51, "development");
      if (afterMerge === null) throw new Error("merged pull unreadable");
      assert.equal(afterMerge.merged, true);
      assert.equal(afterMerge.mergeCommitSha, MERGE);
      assert.deepEqual([...afterMerge.parents], [BASE, HEAD]);
      assert.equal(
        afterMerge.revisionOnBaseBranch,
        true,
        `integration compare was ${integrationCompareBytes} bytes`,
      );
      assert.ok(
        integrationCompareBytes > 1_048_576,
        "the fixture must exceed the ordinary response bound",
      );
      assert.equal(afterMerge.baseSha, BASE);
      assert.equal(afterMerge.baseAncestorOfRevision, true);
      assert.equal(requests.length, 5);
      assert.ok(
        requests[3].includes("/repos/Ubiquity-Sentinel/sentinel/compare/"),
      );
      assert.ok(
        requests[4].includes(
          `/repos/Ubiquity-Sentinel/sentinel/compare/${BASE}...`,
        ),
      );
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "hosted autonomy: a blocked task with an open pull request is retried in one write",
  async () => {
    const { rig, github } = await makeRig("autonomy-retry", {
      repair: repairSnapshot([blockedRecord()], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    });
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "retried");
    assert.notEqual(result.appliedHead, null);
    assert.equal(rig.writes, 1);
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "work");
    assert.equal(record.blocker, null);
    assert.equal(record.counters.retries, 0);
    assert.equal(record.counters.attempts, 1);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a blocked task whose pull request is already merged is not retried",
  async () => {
    const { rig, github } = await makeRig("autonomy-merged-blocked", {
      repair: repairSnapshot([blockedRecord()], [authorizingReceipt()]),
      pull: pullFacts(),
    });
    const result = await run(rig, github);
    assert.equal(rig.writes, 0);
    assert.ok(
      result.actions.some((action) => action.endsWith("pr_not_open")),
    );
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an unreadable pull skips as a read failure while an open one is still planned",
  async () => {
    const { rig, github } = await makeRig("autonomy-retry-read", {
      repair: repairSnapshot([blockedRecord()], [authorizingReceipt()]),
    });
    const throwing: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () => Promise.reject(new Error("transient read failure")),
    };
    const thrown = await run(rig, throwing);
    assert.equal(rig.writes, 0);
    assert.ok(
      thrown.actions.some((action) => action.endsWith("pr_read_failed")),
    );
    assert.ok(
      !thrown.actions.some((action) => action.endsWith("pr_not_open")),
    );

    const unreadable: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () => Promise.resolve(null),
    };
    const unread = await run(rig, unreadable);
    assert.equal(rig.writes, 0);
    assert.ok(
      unread.actions.some((action) => action.endsWith("pr_read_failed")),
    );

    const open: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () =>
        Promise.resolve(
          pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
        ),
    };
    const retried = await run(rig, open);
    assert.equal(retried.status, "applied");
    assert.equal(retried.reason, "retried");
    assert.equal(rig.writes, 1);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with a closed-unmerged pull retires the record",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-unmerged", {
      repair: repairSnapshot(
        [zombieRecord({ intent: zombieIntent() })],
        [authorizingReceipt()],
        [],
        zombieCharges(),
      ),
      pull: pullFacts({
        number: 63,
        state: "closed",
        merged: false,
        mergeCommitSha: null,
      }),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "retired_records");
    assert.equal(rig.writes, 1);
    assert.ok(result.actions.includes(`retire:${ZOMBIE}:issue=61`));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "blocked");
    assert.equal(record.blocker?.message, HOSTED_AUTONOMY_RETIRED);
    assert.equal(record.intent, null);
    // Terminal: the retirement reason matches no retryable prefix.
    assert.equal(
      planHostedRetries(read.value.snapshot, T0 + 900000, ATTEMPT_RUNTIME)
        .length,
      0,
    );
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with an already blocked closed-unmerged record is parked",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-blocked", {
      repair: repairSnapshot(
        [blockedZombie()],
        [authorizingReceipt()],
        [],
        zombieCharges(),
      ),
      pull: pullFacts({
        number: 63,
        state: "closed",
        merged: false,
        mergeCommitSha: null,
      }),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "retired_records");
    assert.equal(rig.writes, 1);
    assert.ok(result.actions.includes(`retire:${ZOMBIE}:issue=61`));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "blocked");
    assert.equal(record.blocker?.message, HOSTED_AUTONOMY_RETIRED);
    assert.equal(record.intent, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with an open pull is not retired",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-open", {
      repair: repairSnapshot([zombieRecord()]),
      pull: pullFacts({
        number: 63,
        state: "open",
        merged: false,
        mergeCommitSha: null,
      }),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(rig.writes, 0);
    assert.ok(!result.actions.some((action) => action.startsWith("retire:")));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "delivery");
    assert.equal(record.blocker, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with a merged pull is not retired",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-merged", {
      repair: repairSnapshot([zombieRecord()]),
      pull: pullFacts({ number: 63, state: "closed", merged: true }),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(rig.writes, 0);
    assert.ok(!result.actions.some((action) => action.startsWith("retire:")));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "delivery");
    assert.equal(record.blocker, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with an unreadable pull is not retired",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-unreadable", {
      repair: repairSnapshot([zombieRecord()]),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const throwing: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () => Promise.reject(new Error("transient read failure")),
    };
    const thrown = await run(rig, throwing);
    assert.equal(rig.writes, 0);
    assert.ok(!thrown.actions.some((action) => action.startsWith("retire:")));
    const unreadable: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () => Promise.resolve(null),
    };
    const unread = await run(rig, unreadable);
    assert.equal(rig.writes, 0);
    assert.ok(!unread.actions.some((action) => action.startsWith("retire:")));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "delivery");
    assert.equal(record.blocker, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with no pull is still retired by the runner",
  async () => {
    const record = deliveryRecord({
      nextStep: "work",
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const { rig, github } = await makeRig("autonomy-retire-nopr", {
      repair: repairSnapshot([record], [authorizingReceipt()]),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "retired_records");
    assert.equal(rig.writes, 1);
    assert.ok(result.actions.includes(`retire:${TARGET}:issue=48`));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const parked = read.value.snapshot.work[0];
    assert.equal(parked.nextStep, "blocked");
    assert.equal(parked.blocker?.message, HOSTED_AUTONOMY_RETIRED);
    assert.equal(parked.intent, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);
