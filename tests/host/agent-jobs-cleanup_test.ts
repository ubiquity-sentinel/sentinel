/**
 * Experimental manual agent-job lane: cleanup request validation and branch
 * deletion against fake GitHub ports, and the pull request body link rewrite.
 * No network or credential.
 */
import assert from "node:assert/strict";
import {
  agentJobsCleanupMatrix,
  type AgentJobsCleanupPorts,
  cleanupAgentJobBranches,
  parseAgentJobsCleanup,
} from "../../ops/agent-jobs-cleanup.ts";
import { linkAgentMessage } from "../../ops/agent-jobs-publish.ts";

const BRANCH = "agent-jobs/fix-a-123-1";

Deno.test("agent jobs cleanup accepts only result branches", () => {
  const entries = parseAgentJobsCleanup([
    { branches: [{ repository: "ubiquity/a", branch: BRANCH }] },
    {
      branches: [
        { repository: "ubiquity/a", branch: BRANCH },
        {
          repository: "ubiquity/b",
          branch: "agent-jobs/x-9-2",
          closePullRequest: true,
        },
        { repository: "ubiquity-sentinel/sentinel", branch: BRANCH },
      ],
    },
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(agentJobsCleanupMatrix(entries).include, [
    { owner: "ubiquity", repositories: "a,b" },
    { owner: "ubiquity-sentinel", repositories: "sentinel" },
  ]);
  for (
    const branch of [
      "development",
      "agent-jobs/fix-a",
      "agent-jobs/../development-1-1",
      "refs/heads/agent-jobs/fix-a-123-1",
      "agent-jobs/fix-a-123-1/x",
    ]
  ) {
    assert.throws(
      () =>
        parseAgentJobsCleanup([{
          branches: [{ repository: "ubiquity/a", branch }],
        }]),
      /only agent-jobs/,
    );
  }
  assert.throws(() => parseAgentJobsCleanup([{ branches: [] }]), /no branch/);
  assert.throws(() => parseAgentJobsCleanup([{ jobs: [] }]), /branches/);
  assert.throws(
    () =>
      parseAgentJobsCleanup([{
        branches: [{ repository: "ubiquity/a", branch: BRANCH, force: true }],
      }]),
    /unknown field force/,
  );
});

Deno.test("agent jobs cleanup keeps open pull requests and survives failures", async () => {
  const deleted: string[] = [];
  const closed: number[] = [];
  const ports: AgentJobsCleanupPorts = {
    openPullRequests: (_repository, branch) =>
      Promise.resolve(branch.startsWith("agent-jobs/open-") ? [7, 8] : []),
    closePullRequest: (_repository, number) => {
      closed.push(number);
      return Promise.resolve();
    },
    deleteBranch: (repository, branch) => {
      if (branch.startsWith("agent-jobs/boom-")) {
        return Promise.reject(new Error("branch delete: HTTP 403"));
      }
      if (branch.startsWith("agent-jobs/gone-")) {
        return Promise.resolve("missing");
      }
      deleted.push(`${repository} ${branch}`);
      return Promise.resolve("deleted");
    },
    log: () => {},
  };
  const results = await cleanupAgentJobBranches(
    parseAgentJobsCleanup([{
      branches: [
        { repository: "ubiquity/a", branch: "agent-jobs/open-1-1" },
        { repository: "ubiquity/a", branch: "agent-jobs/boom-1-1" },
        { repository: "ubiquity/a", branch: "agent-jobs/gone-1-1" },
        {
          repository: "ubiquity/a",
          branch: "agent-jobs/open-2-1",
          closePullRequest: true,
        },
        { repository: "ubiquity/a", branch: "agent-jobs/done-1-1" },
      ],
    }]),
    ports,
  );
  assert.deepEqual(results.map((row) => row.status), [
    "kept_open_pr",
    "failed",
    "missing",
    "deleted",
    "deleted",
  ]);
  assert.equal(results[1].detail, "branch delete: HTTP 403");
  assert.equal(
    results[3].detail,
    "closed pull request 7 closed pull request 8",
  );
  assert.deepEqual(closed, [7, 8]);
  assert.deepEqual(deleted, [
    "ubiquity/a agent-jobs/open-2-1",
    "ubiquity/a agent-jobs/done-1-1",
  ]);
});

Deno.test("agent jobs publish turns runner-local links into repository links", () => {
  const root = "/home/runner/work/_temp/agent-jobs/fix-a/checkout";
  const target = { id: "fix-a", repository: "ubiquity/a", headSha: "abc123" };
  const blob = "https://github.com/ubiquity/a/blob/abc123";
  assert.equal(
    linkAgentMessage(
      `Added [ci.yml](${root}/.github/workflows/ci.yml) and ` +
        `[main](${root}/src/main.ts:12) and [b](${root}/src/b.ts#L7), ` +
        `see [notes](/home/runner/work/_temp/notes.md) and ` +
        `[docs](https://example.com/x) and [rel](docs/a.md).`,
      target,
    ),
    `Added [ci.yml](${blob}/.github/workflows/ci.yml) and ` +
      `[main](${blob}/src/main.ts#L12) and [b](${blob}/src/b.ts#L7), ` +
      `see notes and [docs](https://example.com/x) and [rel](docs/a.md).`,
  );
  // Another job's checkout is not this branch's tree: the link is dropped.
  assert.equal(
    linkAgentMessage(
      "[x](/Users/runner/work/_temp/agent-jobs/other/checkout/a.ts)",
      target,
    ),
    "x",
  );
});
