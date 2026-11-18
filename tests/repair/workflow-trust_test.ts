/**
 * The one safeguard kept under "full access" (2026-11-17), with the owner's
 * same-day admission rule ("i guess sentinel should only automatically
 * handle issues that are either authored by me 0x4007 or the sentinel"): a
 * candidate that changes a CI-executable path is pushed only when its text
 * came from the owner (login and user id) or an App issue of a trusted kind
 * (base-repair; a review follow-up inherits its original issue). Incidents,
 * other App kinds, other authors and a login with a different id are
 * untrusted; an unreadable source is `unavailable`; a path no predicate can
 * classify counts as CI-executable.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitHubIssueV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import {
  ciExecutablePath,
  followUpOriginIssue,
  PROTECTED_PATH_PARK,
  recordCiTrust,
  unsafeChangedPath,
  UNTRUSTED_WORKFLOW_PARK,
  workflowChangeTrust,
} from "../../src/repair/workflow-trust.ts";
import { BASE_REPAIR_AUTHOR } from "../../src/repair/base-repair.ts";
import { parseIssueWire } from "../../src/github/wire.ts";
import { REPO, SHA1, workRecord } from "../state/helpers.ts";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import { positiveLifecycle } from "./loop-candidate-fixtures.ts";

const ISSUE = 41;
const TASK = asWorkItemId(`issue-${ISSUE}`);
const OWNER = { author: "0x4007", authorId: 4975670 };
const APP = { author: BASE_REPAIR_AUTHOR };
const FOLLOW_UP = (origin: number | null) =>
  `<!-- sentinel:review-followup:v2 repo=${REPO.owner}/${REPO.name} pr=9 receipt=r finding=f depth=1 -->\n\n` +
  "Pull request #9 was merged by Sentinel.\n\n- Merged pull request: #9\n" +
  (origin === null ? "" : `- Original issue: #${origin}\n`) +
  "\n### P1 at x\n\n```\n- Original issue: #7\n```\n";

function issueRecord(): ReturnType<typeof workRecord> {
  return workRecord(`issue-${ISSUE}`, {
    source: { kind: "issue", id: String(ISSUE), revision: SHA1 },
    related: { incidentId: null, issueNumber: ISSUE },
    target: {
      base: SHA1,
      branch: candidateBranch(TASK),
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work",
  });
}

/** A reader over a table of issues by number; "down" fails every read. */
function reader(table: Record<number, Partial<GitHubIssueV1>> | "down") {
  const reads: number[] = [];
  return {
    reads,
    github: {
      readIssue(number: number) {
        reads.push(number);
        if (table === "down") {
          return Promise.resolve(portError("unavailable", "down"));
        }
        const issue = table[number];
        if (issue === undefined) return Promise.resolve(portOk(null));
        return Promise.resolve(portOk({
          number,
          title: "t",
          body: "b",
          state: "open",
          author: null,
          labels: [],
          createdAt: 0,
          updatedAt: 0,
          closedAt: null,
          ...issue,
        } as GitHubIssueV1));
      },
    },
  };
}

Deno.test("workflow trust: only the owner (login and id), the App's structured kinds and a follow-up of a trusted issue are trusted", async () => {
  const record = issueRecord();
  const cases: [Record<number, Partial<GitHubIssueV1>> | "down", string][] = [
    [{ [ISSUE]: OWNER }, "trusted"],
    [{ [ISSUE]: { author: "0X4007", authorId: 4975670 } }, "trusted"],
    [
      {
        [ISSUE]: { ...APP, body: "<!-- sentinel:base-repair:development -->" },
      },
      "trusted",
    ],
    [
      {
        [ISSUE]: {
          ...APP,
          body:
            "<!-- sentinel:skip -->\n<!-- sentinel:target-capability -->\n\nCI is required.",
        },
      },
      "trusted",
    ],
    [
      {
        [ISSUE]: {
          ...APP,
          body: "<!-- sentinel:target-capability -->\n<!-- sentinel:skip -->",
        },
      },
      "untrusted",
    ],
    [
      {
        [ISSUE]: {
          author: "x",
          body: "<!-- sentinel:skip -->\n" +
            "<!-- sentinel:target-capability -->",
        },
      },
      "untrusted",
    ],
    [{ [ISSUE]: { ...APP, body: FOLLOW_UP(7) }, 7: OWNER }, "trusted"],
    [
      { [ISSUE]: { ...APP, body: FOLLOW_UP(7) }, 7: { author: "x" } },
      "untrusted",
    ],
    [{ [ISSUE]: { ...APP, body: FOLLOW_UP(null) } }, "untrusted"],
    [{ [ISSUE]: { ...APP, body: FOLLOW_UP(ISSUE) } }, "untrusted"],
    [
      { [ISSUE]: { ...APP, body: "an App issue of another kind" } },
      "untrusted",
    ],
    [{ [ISSUE]: { author: "0x4007", authorId: 1 } }, "untrusted"],
    [{ [ISSUE]: { author: "0x4007" } }, "untrusted"],
    [
      { [ISSUE]: { author: "member", authorAssociation: "MEMBER" } },
      "untrusted",
    ],
    // A follow-up whose original issue does not exist vouches for nothing.
    [{ [ISSUE]: { ...APP, body: FOLLOW_UP(7) } }, "untrusted"],
    ["down", "unavailable"],
  ];
  for (const [table, verdict] of cases) {
    const port = reader(table);
    assert.equal(
      await recordCiTrust(port as never, record),
      verdict,
      JSON.stringify(table),
    );
  }
});

Deno.test("workflow trust: a follow-up's origin is read only from its own header, and only for this repository", () => {
  assert.equal(followUpOriginIssue(FOLLOW_UP(7), REPO), 7);
  assert.equal(followUpOriginIssue(FOLLOW_UP(null), REPO), null);
  assert.equal(
    followUpOriginIssue(FOLLOW_UP(7), { owner: "ubiquity", name: "other" }),
    null,
  );
  assert.equal(followUpOriginIssue("- Original issue: #7", REPO), null);
});

Deno.test("workflow trust: an incident is untrusted without a read; a non-CI change costs no read", async () => {
  const port = reader({ [ISSUE]: { author: "x" } });
  const incident = {
    repository: { ...REPO },
    related: { incidentId: "incident-1", issueNumber: null },
  };
  assert.equal(
    await workflowChangeTrust(port as never, incident, [".github/x.yml"]),
    "untrusted",
  );
  for (const paths of [["src/a.ts"], ["docs/.github-notes.md", "AGENTS.md"]]) {
    assert.equal(
      await workflowChangeTrust(port as never, issueRecord(), paths),
      "trusted",
    );
  }
  assert.deepEqual(port.reads, []);
});

Deno.test("workflow trust: a path no predicate can classify is CI-executable", () => {
  for (
    const path of [
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      ".github/dependabot.yml",
      "./.github/workflows/x.yml",
      '".github/workflows/d\\303\\251ploy.yml"',
      "a\\b.yml",
      "/etc/x",
      "a/../.github/x",
      "a//b",
      "tab\there",
      "",
    ]
  ) assert.equal(ciExecutablePath(path), true, JSON.stringify(path));
  for (
    const path of ["github/x.yml", "src/.github/x", "docs/", "src/日本.ts"]
  ) {
    assert.equal(ciExecutablePath(path), false, path);
    assert.equal(unsafeChangedPath(path), false, path);
  }
});

Deno.test("workflow trust: the issue wire carries a known author association and the numeric author id only", () => {
  const wire = {
    number: 3,
    title: "t",
    body: "b",
    state: "open",
    user: { login: "0x4007", id: 4975670 },
    labels: [],
    created_at: "2026-11-17T00:00:00Z",
    updated_at: "2026-11-17T00:00:00Z",
    closed_at: null,
  };
  const known = parseIssueWire({ ...wire, author_association: "MEMBER" }, "$");
  assert.ok(known.kind === "issue");
  assert.equal(known.issue.authorAssociation, "MEMBER");
  assert.equal(known.issue.authorId, 4975670);
  for (const value of [undefined, "ROOT", 7]) {
    const parsed = parseIssueWire({ ...wire, author_association: value }, "$");
    assert.ok(parsed.kind === "issue");
    assert.equal("authorAssociation" in parsed.issue, false, String(value));
  }
  for (const id of [undefined, 0, -1, "4975670", 1.5]) {
    const parsed = parseIssueWire({ ...wire, user: { login: "x", id } }, "$");
    assert.ok(parsed.kind === "issue");
    assert.equal("authorId" in parsed.issue, false, String(id));
  }
});

async function runTarget(
  author: Partial<GitHubIssueV1>,
  changedPaths: string[],
) {
  const rig = await makeRig(`wftrust${changedPaths.length}`, {
    summaries: false,
    configOverrides: {
      repository: { ...REPO },
      protectedPaths: [".github/workflows/", "docs/"],
    },
    model: { changedPaths },
    github: {
      candidateLifecycle: positiveLifecycle(),
      issues: [{ number: ISSUE, ...author }],
      pushedPaths: changedPaths,
    },
  });
  const written = await rig.store.writeRepair(
    seededSnapshot([issueRecord()]),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  return rig;
}

Deno.test("workflow trust: through the loop, the owner's workflow candidate is pushed and an App issue of another kind parks", async () => {
  const paths = ["src/app.ts", ".github/workflows/ci.yml"];
  const trusted = await runTarget(OWNER, paths);
  try {
    const outcome = await trusted.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const work = (await trusted.snapshot()).work[0]!;
    assert.equal(work.blocker, null, JSON.stringify(work.blocker));
    assert.equal(work.nextStep, "review");
    assert.equal(work.ownerLanding, undefined);
    assert.equal(trusted.github.pushes.length, 1);
  } finally {
    await trusted.ctx.cleanup();
  }
  const rig = await runTarget({ ...APP, body: "plain App text" }, paths);
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const work = (await rig.snapshot()).work[0]!;
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.blocker?.message, UNTRUSTED_WORKFLOW_PARK);
    assert.equal(work.target.pr, null);
    assert.equal(rig.github.pushes.length, 0, "nothing is pushed");
    assert.ok(!rig.github.calls.includes("createPr"));
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("workflow trust: an unreadable source parks nothing and the push guard sends nothing", async () => {
  const paths = ["src/app.ts", ".github/workflows/ci.yml"];
  const rig = await runTarget(OWNER, paths);
  try {
    // Every issue read fails after admission: the trust read is transient.
    const read = rig.github.readIssue.bind(rig.github);
    let reads = 0;
    rig.github.readIssue = (number: number) => {
      reads++;
      return reads === 1
        ? read(number)
        : Promise.resolve(portError("unavailable", "down"));
    };
    await rig.run();
    const work = (await rig.snapshot()).work[0]!;
    assert.notEqual(work.blocker?.message, PROTECTED_PATH_PARK);
    assert.notEqual(work.blocker?.message, UNTRUSTED_WORKFLOW_PARK);
    assert.notEqual(work.nextStep, "blocked", JSON.stringify(work));
    assert.equal(rig.github.pushes.length, 0, "nothing is pushed");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("workflow trust: through the loop, an owner's non-workflow protected change publishes as an ordinary pull request", async () => {
  const rig = await runTarget(OWNER, ["src/app.ts", "docs/guide.md"]);
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const work = (await rig.snapshot()).work[0]!;
    assert.equal(work.blocker, null, JSON.stringify(work.blocker));
    assert.equal(work.nextStep, "review");
    assert.equal(work.ownerLanding, undefined);
    assert.equal(rig.github.pushes.length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});
