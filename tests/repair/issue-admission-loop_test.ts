/**
 * Owner directive 2026-11-17, verbatim: "i guess sentinel should only
 * automatically handle issues that are either authored by me 0x4007 or the
 * sentinel". Through the real loop, on every target: intake skips another
 * author's issue with the closed reason `author_not_admitted` and charges
 * nothing; an existing record of such an issue is parked uncharged before any
 * model start, review round or merge, and nothing is pushed; the owner's and
 * the App's issues are worked as before. (The closed texts are spelled out,
 * and options pass through variables, so this file also runs against the
 * tree before the change, where every case fails.)
 */
import assert from "node:assert/strict";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import type { GitHubIssueV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { sanitizeSkippedIssue } from "../../src/github/client-response.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { REPO, SHA1, SHA3, workRecord } from "../state/helpers.ts";
import {
  check,
  ciFirstRig,
  reviewCharges,
  taskRecord,
} from "./ci-first-rig.ts";
import {
  issueRecord,
  makeMemoryRig,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { positiveLifecycle } from "./loop-candidate-fixtures.ts";

const NOT_ADMITTED_REASON = "author_not_admitted";
const NOT_ADMITTED_PARK = "issue author is not admitted; owner action required";
const OWNER = { author: "0x4007", authorId: 4975670 };
const APP = { author: "ubiquity-sentinel[bot]", authorId: undefined };
const OWNER_LOGIN_ONLY = { author: "0x4007", authorId: undefined };
const MEMBER = {
  author: "pavlovcik-member",
  authorId: 1234,
  authorAssociation: "MEMBER",
};
const COLLABORATOR = {
  author: "a-collaborator",
  authorId: 5678,
  authorAssociation: "COLLABORATOR",
};
const IMPOSTER = { author: "0x4007", authorId: 1 };
const TARGETS = [
  { owner: "ubiquity-sentinel", name: "sentinel" },
  { owner: "ubiquity", name: "ai.ubq.fi" },
  { owner: "ubiquity", name: "passport.ubq.fi" },
] as const;

async function intakeOn(
  repository: { owner: string; name: string },
  listed: GitHubIssueV1[],
) {
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listed = listed;
  const rig = makeMemoryRig(github);
  rig.configs[0] = {
    ...rig.configs[0],
    repository: { ...repository, installationId: REPO.installationId },
  };
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (line: unknown) => logs.push(String(line));
    await rig.run();
  } finally {
    console.log = originalLog;
  }
  const line = logs.flatMap((text) => {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }).find((row) => row.kind === "sentinel_issue_intake");
  return { rig, line, github };
}

Deno.test("issue admission: on every target another author's issue is skipped at intake, reported and uncharged", async () => {
  for (const repository of TARGETS) {
    const { rig, line, github } = await intakeOn(repository, [
      issueRecord(1, OWNER),
      issueRecord(2, APP),
      issueRecord(3, MEMBER),
      issueRecord(4, COLLABORATOR),
      issueRecord(5, IMPOSTER),
      issueRecord(6, OWNER_LOGIN_ONLY),
    ]);
    const label = `${repository.owner}/${repository.name}`;
    const state = await rig.snapshot();
    assert.deepEqual(
      state.work.map((row) => row.related.issueNumber).sort(),
      [1, 2],
      label,
    );
    const rows = [3, 4, 5, 6].map((number) => ({
      number,
      code: "not_admitted",
      reason: NOT_ADMITTED_REASON,
    }));
    assert.deepEqual(line?.skippedIssues, rows, label);
    // The launcher's summary reader accepts the reason.
    for (const row of rows) {
      assert.deepEqual(sanitizeSkippedIssue(row, label), row);
    }
    // Nothing is charged, read again or said about a skipped issue.
    const skippedTasks = new Set(
      state.work.filter((work) =>
        [3, 4, 5, 6].includes(work.related.issueNumber ?? 0)
      ).map((work) => work.id),
    );
    assert.equal(skippedTasks.size, 0, label);
    assert.ok(
      state.reservations.every((row) =>
        state.work.some((work) =>
          work.id === row.taskId &&
          [1, 2].includes(work.related.issueNumber ?? 0)
        )
      ),
      label,
    );
    for (const number of [3, 4, 5, 6]) {
      assert.ok(
        !github.calls.includes(`readIssue:${number}`),
        `${label} #${number}: ${github.calls.join(",")}`,
      );
    }
    assert.ok(
      !github.calls.some((call) => call.startsWith("comment")),
      github.calls.join(","),
    );
  }
});

/** One seeded record of issue #41 (at `work`, nothing published yet). */
async function existingRecord(
  name: string,
  author: Partial<GitHubIssueV1>,
) {
  const githubOptions = {
    candidateLifecycle: positiveLifecycle(),
    issues: [{ number: 41, ...author }],
  };
  const rig = await makeRig(name, {
    summaries: false,
    configOverrides: { repository: { ...REPO } },
    model: { changedPaths: ["src/app.ts"] },
    github: githubOptions,
  });
  const task = asWorkItemId("issue-41");
  const written = await rig.store.writeRepair(
    seededSnapshot([workRecord(task, {
      repository: { ...REPO },
      source: { kind: "issue", id: "41", revision: SHA1 },
      related: { incidentId: null, issueNumber: 41 },
      target: {
        base: SHA1,
        branch: candidateBranch(task),
        checkpoint: null,
        head: null,
        pr: null,
      },
      nextStep: "work",
    })]),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  return rig;
}

Deno.test("issue admission: an existing record of another author is parked before any model start, uncharged, nothing pushed", async () => {
  for (const author of [MEMBER, COLLABORATOR, IMPOSTER]) {
    const rig = await existingRecord("admission-start", author);
    try {
      const outcome = await rig.run();
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const after = await rig.snapshot();
      const work = after.work[0]!;
      assert.equal(work.nextStep, "blocked", JSON.stringify(work));
      assert.equal(work.blocker?.message, NOT_ADMITTED_PARK);
      assert.equal(work.intent, null);
      assert.equal(rig.model.requests.length, 0, "no model start");
      assert.deepEqual(after.reservations, [], "nothing reserved or charged");
      assert.equal(rig.github.pushes.length, 0, "nothing pushed");
      assert.ok(!rig.github.calls.includes("createPr"));
    } finally {
      await rig.ctx.cleanup();
    }
  }
  // The owner's own record starts as before.
  const owner = await existingRecord("admission-owner", OWNER);
  try {
    await owner.run();
    assert.equal(owner.model.requests.length, 1);
    assert.notEqual(
      (await owner.snapshot()).work[0]!.blocker?.message,
      NOT_ADMITTED_PARK,
    );
  } finally {
    await owner.ctx.cleanup();
  }
});

/** Every read of issue #1 reports `author` (the text is unchanged). */
function authoredBy(
  rig: Awaited<ReturnType<typeof ciFirstRig>>["rig"],
  author: Partial<GitHubIssueV1>,
): void {
  const read = rig.github.readIssue.bind(rig.github);
  rig.github.readIssue = async (number: number) => {
    const issue = await read(number);
    if (!issue.ok || issue.value === null) return issue;
    const { authorId: _id, authorAssociation: _a, ...rest } = issue
      .value as GitHubIssueV1 & { authorId?: number };
    return portOk({ ...rest, ...author } as GitHubIssueV1);
  };
}

Deno.test("issue admission: an existing published record of another author spends no review round", async () => {
  const { rig } = await ciFirstRig("admission-review", {
    checks: { [SHA3]: [check("ci", SHA3 as GitSha, "success")] },
  });
  authoredBy(rig, MEMBER);
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "blocked", JSON.stringify(work));
    assert.equal(work.blocker?.message, NOT_ADMITTED_PARK);
    assert.equal(reviewCharges(after).length, 0, "no review round reserved");
    assert.ok(!rig.github.calls.includes("requestReview"));
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("issue admission: a reviewed pull request of another author is never merged by Sentinel", async () => {
  for (const [author, merges] of [[MEMBER, 0], [OWNER, 1]] as const) {
    const { rig } = await ciFirstRig("admission-merge", {
      checks: { [SHA3]: [check("ci", SHA3 as GitSha, "success")] },
      reviewed: true,
      reviewRounds: 1,
      nextStep: "delivery",
    });
    authoredBy(rig, author);
    try {
      await rig.run();
      const work = taskRecord(await rig.snapshot());
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        merges,
        JSON.stringify(work),
      );
      if (merges === 0) {
        assert.equal(work.nextStep, "blocked");
        assert.equal(work.blocker?.message, NOT_ADMITTED_PARK);
        assert.equal(work.intent, null, "no merge intent");
      }
    } finally {
      await rig.ctx.cleanup();
    }
  }
});
