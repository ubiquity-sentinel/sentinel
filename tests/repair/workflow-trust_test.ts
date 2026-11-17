/**
 * The one safeguard kept under "full access" (2026-11-17): a candidate that
 * changes a CI-executable path is pushed only on a trusted issue's authority
 * (the Sentinel App, or an OWNER/MEMBER/COLLABORATOR author); an outsider's
 * issue parks with its own reason, an unreadable author fails closed into the
 * protected park, and a protected change that CI never executes publishes.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitHubIssueV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import {
  ciExecutablePath,
  PROTECTED_PATH_PARK,
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

function reader(issue: Partial<GitHubIssueV1> | "down") {
  const reads: number[] = [];
  return {
    reads,
    github: {
      readIssue(number: number) {
        reads.push(number);
        if (issue === "down") {
          return Promise.resolve(portError("unavailable", "down"));
        }
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

Deno.test("workflow trust: the App and trusted associations push, outsiders and unreadable authors do not", async () => {
  const record = issueRecord();
  const workflow = ["src/a.ts", ".github/workflows/ci.yml"];
  const cases: [Partial<GitHubIssueV1> | "down", string][] = [
    [{ author: BASE_REPAIR_AUTHOR }, "trusted"],
    [{ author: "owner", authorAssociation: "OWNER" }, "trusted"],
    [{ author: "member", authorAssociation: "MEMBER" }, "trusted"],
    [{ author: "c", authorAssociation: "COLLABORATOR" }, "trusted"],
    [{ author: "x", authorAssociation: "NONE" }, "untrusted"],
    [{ author: "x", authorAssociation: "CONTRIBUTOR" }, "untrusted"],
    [{ author: "x", authorAssociation: "FIRST_TIME_CONTRIBUTOR" }, "untrusted"],
    [{ author: "x" }, "unavailable"],
    ["down", "unavailable"],
  ];
  for (const [issue, verdict] of cases) {
    const port = reader(issue);
    assert.equal(
      await workflowChangeTrust(
        port as never,
        record,
        workflow,
      ),
      verdict,
      JSON.stringify(issue),
    );
    assert.deepEqual(port.reads, [ISSUE]);
  }
  // A mismatched read proves nothing.
  const wrong = reader({ number: ISSUE + 1, authorAssociation: "OWNER" });
  assert.equal(
    await workflowChangeTrust(wrong as never, record, workflow),
    "unavailable",
  );
});

Deno.test("workflow trust: a change CI never executes costs no read; an issue-less task is trusted", async () => {
  const port = reader({ author: "x", authorAssociation: "NONE" });
  for (const paths of [["src/a.ts"], ["docs/.github-notes.md", "AGENTS.md"]]) {
    assert.equal(
      await workflowChangeTrust(port as never, issueRecord(), paths),
      "trusted",
    );
  }
  assert.deepEqual(port.reads, []);
  const incident = {
    source: { kind: "incident" as const, id: "incident-1", revision: SHA1 },
    related: { incidentId: "incident-1", issueNumber: null },
  };
  assert.equal(
    await workflowChangeTrust(port as never, incident, [".github/x.yml"]),
    "trusted",
  );
  // An issue task that names no issue number proves nothing.
  const orphan = { ...incident, source: { ...incident.source, kind: "issue" } };
  assert.equal(
    await workflowChangeTrust(port as never, orphan as never, [".github/x"]),
    "unavailable",
  );
  assert.deepEqual(port.reads, []);
  for (
    const path of [
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      ".github/dependabot.yml",
      "./.github/workflows/x.yml",
    ]
  ) assert.equal(ciExecutablePath(path), true, path);
  for (const path of ["github/x.yml", "src/.github/x", "docs/"]) {
    assert.equal(ciExecutablePath(path), false, path);
  }
});

Deno.test("workflow trust: the issue wire carries a known author association only", () => {
  const wire = {
    number: 3,
    title: "t",
    body: "b",
    state: "open",
    user: { login: "someone" },
    labels: [],
    created_at: "2026-11-17T00:00:00Z",
    updated_at: "2026-11-17T00:00:00Z",
    closed_at: null,
  };
  const known = parseIssueWire({ ...wire, author_association: "MEMBER" }, "$");
  assert.ok(known.kind === "issue");
  assert.equal(known.issue.authorAssociation, "MEMBER");
  for (const value of [undefined, "ROOT", 7]) {
    const parsed = parseIssueWire({ ...wire, author_association: value }, "$");
    assert.ok(parsed.kind === "issue");
    assert.equal("authorAssociation" in parsed.issue, false, String(value));
  }
});

async function runTarget(
  author: Partial<GitHubIssueV1> | null,
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
      ...(author === null ? {} : { issues: [{ number: ISSUE, ...author }] }),
    },
  });
  const written = await rig.store.writeRepair(
    seededSnapshot([issueRecord()]),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  return rig;
}

Deno.test("workflow trust: through the loop, a trusted author's workflow candidate is pushed and an outsider's parks", async () => {
  const paths = ["src/app.ts", ".github/workflows/ci.yml"];
  const trusted = await runTarget({ authorAssociation: "COLLABORATOR" }, paths);
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
  for (
    const [author, message] of [
      [{ authorAssociation: "NONE" }, UNTRUSTED_WORKFLOW_PARK],
      [{}, PROTECTED_PATH_PARK],
    ] as const
  ) {
    const rig = await runTarget(author, paths);
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const work = (await rig.snapshot()).work[0]!;
      assert.equal(work.nextStep, "blocked");
      assert.equal(work.blocker?.message, message);
      assert.equal(work.target.pr, null);
      assert.equal(rig.github.pushes.length, 0, "nothing is pushed");
      assert.ok(!rig.github.calls.includes("createPr"));
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("workflow trust: through the loop, an outsider's non-workflow protected change publishes as an ordinary pull request", async () => {
  const rig = await runTarget({ authorAssociation: "NONE" }, [
    "src/app.ts",
    "docs/guide.md",
  ]);
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
