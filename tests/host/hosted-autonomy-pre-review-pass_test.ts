/**
 * The REAL retry pass over the runtime's pre-review CI parks (issue #153),
 * under the exact pinned R80 with the launcher's production allowlists: the
 * launcher half that ships before generation 81's runtime.
 *
 * - A red pre-review park whose base moved returns to `work` uncharged: R80
 *   (a proven CI-first runtime) refreshes it deterministically and gates the
 *   refreshed head's CI before any review (ci-first-rollback-gen80_test.ts
 *   runs R80's own loop over exactly this write). Under R80 alone a park on
 *   its unchanged base is not touched: R80's hosted fix route is closed.
 * - The exhausted park (three CI fixes spent) is read for green CI on its
 *   unchanged base like the other pre-review parks: green again it returns
 *   to `work` for its review; red, or on a moved base, it stays parked.
 * Every write parses under R80, generation 81's rollback target.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import {
  readHostedClosedIssues,
  runHostedRetryPass,
} from "../../ops/hosted-autonomy-retry-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import { HOSTED_AUTONOMY_CI_FIRST_RUNTIMES } from "../../ops/hosted-autonomy-ci-first.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";
import { assertGen80Parses, gen80Available } from "../state/gen77-contracts.ts";
import { blockedRecord } from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";
import { releaseAt } from "./hosted-autonomy-preservation-fixtures.ts";

const GEN80 = await gen80Available();
const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
/** R80 exactly as the generation-80 install pin names it. */
const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
const PASS_NOW = T0 + 5_000_000;
/** Development's tip; SHA1 is the base it moved from. */
const TIP = SHA2;
const RED_PARK = "CI red before review; awaiting a CI fix: validate(failure)";
const EXHAUSTED_PARK = "CI fix attempts exhausted (3 of 3): validate(failure)";

/** One published ai.ubq.fi head parked by the runtime's pre-review gate. */
function parked(
  issue: number,
  base: GitSha,
  message: string,
  retries: number,
): WorkRecordV1 {
  const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
  const head = String(issue).padStart(4, "0").repeat(10) as GitSha;
  return parseWorkRecordV1({
    ...blockedRecord(),
    repository: AI,
    id,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    blocker: { kind: "other", message, since: T0 + 5000 },
    target: {
      base,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head,
      pr: 3000 + issue,
      candidateState: {
        preserved: {
          operationKey: `impl:${"d".repeat(64)}`,
          base,
          head,
          ref: `refs/heads/sentinel-candidates/${"c".repeat(64)}`,
        },
        publishedHead: head,
      },
    },
    counters: { attempts: 1 + retries, retries, reviewRounds: 1 },
  });
}

/** R80 at generation 80 with its own healthy proof. */
const RELEASE = releaseAt({
  revision: R80,
  generation: 80,
  healthy: {
    revision: R80,
    generation: 80,
    createdAt: T0 + 100,
    observedAt: T0 + 110,
  },
});

Deno.test("pre-review parks (retry pass, R80 installed): a moved base returns for its uncharged refresh, a green exhausted head for its review", async () => {
  assert.ok(HOSTED_AUTONOMY_CI_FIRST_RUNTIMES.has(R80), "R80 is CI-first");
  const moved = parked(2001, SHA1, RED_PARK, 0);
  const unchanged = parked(2002, TIP, RED_PARK, 1);
  const greenExhausted = parked(2003, TIP, EXHAUSTED_PARK, 3);
  const redExhausted = parked(2004, TIP, EXHAUSTED_PARK, 3);
  const movedExhausted = parked(2005, SHA1, EXHAUSTED_PARK, 3);
  const records = [
    moved,
    unchanged,
    greenExhausted,
    redExhausted,
    movedExhausted,
  ];
  const snapshot = repairSnapshot(records, [], [], []);
  const { rig, github } = await makeRig("pre-review-pass", {
    repair: snapshot,
    baseTip: TIP,
    issueOpen: true,
  });
  const read: string[] = [];
  rig.githubFor = () => ({
    ...github,
    readPull: (number: number) =>
      Promise.resolve({
        number,
        state: "open",
        merged: false,
        mergeCommitSha: null,
        headSha: records.find((record) => record.target.pr === number)!
          .target.head,
        baseRef: "development",
        author: "ubiquity-sentinel[bot]",
      } as unknown as HostedAutonomyPullV1),
    hasAllChecksGreen: (sha: string) => {
      read.push(sha);
      return Promise.resolve(sha === greenExhausted.target.head);
    },
    listHeadRuns: () => Promise.resolve([]),
    rerunFailedJobs: () => Promise.reject(new Error("never re-run here")),
  });
  try {
    const deps = {
      state: rig.state,
      githubFor: rig.githubFor,
      clock: { now: () => PASS_NOW },
    } as unknown as HostedAutonomyDepsV1;
    const before = await rig.state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const context = {
      deps,
      actions: [] as string[],
      revisions: [],
      snapshot: before.value.snapshot,
      observedHead: before.value.head,
      initialHead: before.value.head,
      releaseSnapshot: RELEASE,
      closedIssues: new Set<string>(),
      foreignMerged: new Map(),
      dedicatedReservations: new Set<string>(),
      ...createHostedAutonomyScopes(deps),
    } as unknown as HostedAutonomyPassContextV1;
    await readHostedClosedIssues(context);
    const result = await runHostedRetryPass(context, SHA1);
    assert.equal(result?.status, "applied", JSON.stringify(context.actions));
    const actions = context.actions.filter((line) => line.startsWith("retry:"));
    assert.deepEqual(
      actions.sort(),
      [
        `retry:${moved.id}:grant=0:other:CI red before review; awaiting a CI fix::base-moved`,
        `retry:${greenExhausted.id}:grant=0:other:CI fix attempts exhausted (3 of 3)::green`,
      ].sort(),
      JSON.stringify(context.actions),
    );
    // Only heads on the unchanged base are read for green CI.
    assert.deepEqual(
      [...new Set(read)].sort(),
      [unchanged, greenExhausted, redExhausted].map((record) =>
        record.target.head!
      ).sort(),
    );
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    const byId = new Map(
      after.value.snapshot.work.map((record) => [record.id, record]),
    );
    for (const record of [moved, greenExhausted]) {
      const returned = byId.get(record.id)!;
      assert.equal(returned.nextStep, "work", record.id);
      assert.equal(returned.blocker, null);
      assert.equal(returned.wait, null, "no fix marker");
      assert.equal(returned.intent, null);
      assert.deepEqual(returned.target, record.target);
      assert.deepEqual(returned.counters, record.counters, "uncharged");
    }
    for (const record of [unchanged, redExhausted, movedExhausted]) {
      assert.deepEqual(byId.get(record.id), record, record.id);
    }
    assert.deepEqual(after.value.snapshot.reservations, []);
    if (GEN80) await assertGen80Parses(after.value.snapshot);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
