/**
 * The launcher's admission gate (owner directive 2026-11-17, "sentinel
 * should only automatically handle issues that are either authored by me
 * 0x4007 or the sentinel"): the launcher runs before the runtime each cycle
 * and merges through its own adapter, so every launcher merge (delivery,
 * spent delivery, a train member) reads the source issue's author live and
 * refuses unless it is the owner account (login and id) or the App. An
 * unreadable author merges nothing (the record waits). Through the real
 * delivery pass and the real train composer.
 */
import assert from "node:assert/strict";
import { createMetricsCollectorV1 } from "../../src/contracts/throughput-metrics-collector.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy.ts";
import type { HostedIssueFactsV1 } from "../../ops/hosted-autonomy-issue-facts.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  deliveryRecord,
  finding,
  HEAD,
  pullFacts,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  ownerIssueFacts,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";
import { makeTrainWorld, type MemberSpecV1 } from "./delivery-train-rig.ts";
import { T0 } from "../state/helpers.ts";

type Facts = Partial<HostedIssueFactsV1> | null;
const OUTSIDER: Facts = { author: "someone-else", authorId: 9 };
const OWNER_LOGIN_OTHER_ID: Facts = { author: "0x4007", authorId: 1 };
const APP: Facts = { author: "ubiquity-sentinel[bot]" };
const OWNER: Facts = { author: "0x4007", authorId: 4975670 };

const CASES: Array<[string, Facts, number, string | null]> = [
  ["the owner's issue merges", OWNER, 1, null],
  ["the App's issue merges", APP, 1, null],
  ["another author's issue never merges", OUTSIDER, 0, "issue_not_admitted"],
  [
    "the owner's login with another id never merges",
    OWNER_LOGIN_OTHER_ID,
    0,
    "issue_not_admitted",
  ],
  ["an unreadable author merges nothing", null, 0, "issue_author_unverified"],
];

Deno.test("admission: the delivery pass merges only the owner's and the App's issues", async (t) => {
  for (const [name, facts, merges, refusal] of CASES) {
    await t.step(name, async () => {
      const { rig, github } = await makeRig("autonomy-admission-delivery", {
        repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
        pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
        afterMerge: pullFacts(),
        issueFacts: () => facts,
      });
      try {
        const result = await run(rig, github);
        assert.equal(rig.merges, merges, JSON.stringify(result.actions));
        if (refusal !== null) {
          assert.ok(
            result.actions.some((line) => line.endsWith(`:${refusal}`)),
            JSON.stringify(result.actions),
          );
        }
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

const TARGET = {
  owner: "ubiquity",
  name: "generic-target",
  installationId: 7,
} as const;

Deno.test("admission: spent delivery merges only the owner's and the App's issues", async (t) => {
  for (const [name, facts, merges, refusal] of CASES) {
    await t.step(name, async () => {
      // A parked head whose review authorizes delivery (P2 only).
      const record = blockedRecord({
        repository: TARGET,
        blocker: {
          kind: "review_quota",
          message: "review rounds exhausted without an accepted verdict (P2)",
          since: 1,
        },
        counters: { attempts: 4, retries: 1, reviewRounds: 3 },
        target: {
          base: BASE,
          branch: "sentinel/repair/issue-ubiquity-generic-target-48",
          checkpoint: null,
          head: HEAD,
          pr: 51,
        },
      });
      const receipt = authorizingReceipt({
        repository: TARGET,
        findings: [finding("P2")],
        unresolvedSeverities: ["P2"],
      });
      const { rig, github } = await makeRig("autonomy-admission-spent", {
        repair: repairSnapshot([record], [receipt]),
        defaultBranch: "development",
        pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
        afterMerge: pullFacts(),
        issueFacts: () => facts,
      });
      try {
        github.listPullFiles = () => Promise.resolve(["src/app.ts"]);
        const result = await run(rig, github);
        assert.equal(rig.merges, merges, JSON.stringify(result.actions));
        if (refusal !== null) {
          assert.ok(
            result.actions.some((line) => line.endsWith(`:${refusal}`)),
            JSON.stringify(result.actions),
          );
        }
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

const SPECS: MemberSpecV1[] = [0, 1, 2, 3, 4].map((index) => ({
  file: `feature-${index}.txt`,
  content: `feature ${index}\n`,
}));

Deno.test("admission: a train never carries or merges another author's issue; the others land", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "sentinel-train-admission-" });
  const world = await makeTrainWorld(tmp, SPECS, { now: () => T0 });
  const { rig, github } = await makeRig("train-admission", {
    repair: repairSnapshot(
      world.members.map((m) => m.record),
      world.members.map((m) => m.receipt),
    ),
  });
  const outsider = world.members[2];
  const base = world.surface(github);
  const surface: HostedAutonomyGitHubV1 = {
    ...base,
    listPullFiles: (number: number) =>
      Promise.resolve([
        SPECS[world.members.findIndex((m) => m.pr === number)]?.file ??
          "x.txt",
      ]),
    readIssueFacts: (number: number) =>
      Promise.resolve(
        ownerIssueFacts(
          number,
          number === outsider.issue ? () => OUTSIDER : undefined,
        ),
      ),
  };
  try {
    const { actions } = await run(rig, surface, {
      deliveryTrain: world.trainDeps,
      metrics: createMetricsCollectorV1(),
    });
    const text = JSON.stringify(actions);
    assert.ok(!world.merges.includes(outsider.pr), text);
    assert.equal(world.merges.length, 4, text);
    // Not a train member, and the per-record path does not merge it either.
    assert.ok(
      actions.some((line) =>
        line.startsWith("train:") && line.includes(":built:") &&
        !line.includes(outsider.id)
      ),
      text,
    );
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.notEqual(
      read.value.snapshot.work.find((row) => row.id === outsider.id)
        ?.nextStep,
      "done",
      text,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
    await Deno.remove(tmp, { recursive: true });
  }
});
