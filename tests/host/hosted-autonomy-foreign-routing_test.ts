import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import { resolveHostedDelivery } from "../../ops/hosted-autonomy-delivery-proof.ts";
import { createHostedAutonomyScopes } from "../../ops/hosted-autonomy-scopes.ts";
import {
  createHostedAutonomyGitHub,
  hostedDeliveryKey,
  hostedIssueKey,
  hostedRepositoryKey,
  planHostedClosures,
  planHostedRetirements,
} from "../../ops/hosted-autonomy.ts";
import { SHA1 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  checkRun,
  checkRunPage,
  closureTasks,
  deliveryRecord,
  FOREIGN_BRANCH,
  FOREIGN_PR,
  FOREIGN_REPO,
  FOREIGN_TARGET,
  FOREIGN_TASK_BODY,
  FOREIGN_TASK_TITLE,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
  isForeignPath,
  isSelfPath,
  isSelfRepository,
  jsonResponse,
  MERGE,
  pullFacts,
  SELF_REPO,
  SELF_TASK_120,
  SHARED_ISSUE_NUMBER,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  readRequests,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

Deno.test(
  "hosted autonomy: a foreign record is routed to its own repository surface",
  async () => {
    // The runner resolves the record's OWN identity: the sentinel scope is
    // never even resolved for a foreign record.
    const resolved: string[] = [];
    const { rig, github } = await makeRig("autonomy-foreign-routing", {
      repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
      pull: foreignPullFacts({
        state: "open",
        merged: false,
        mergeCommitSha: null,
      }),
      afterMerge: foreignPullFacts(),
      resolver: (repository) => {
        resolved.push(hostedRepositoryKey(repository));
        return github;
      },
    });
    const result = await run(rig);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(rig.merges, 1);
    assert.ok(resolved.length > 0);
    assert.deepEqual([...new Set(resolved)], [
      hostedRepositoryKey(FOREIGN_REPO),
    ]);
    assert.ok(!resolved.includes(hostedRepositoryKey(SELF_REPO)));
    await Deno.remove(rig.tmp, { recursive: true });

    // The real factory builds EVERY REST path for the identity it was given.
    // A sentinel path is not served at all here, so any sentinel read would
    // make this case fail instead of silently succeeding.
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (!isForeignPath(url)) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      const payload = url.includes("/pulls/")
        ? {
          state: "open",
          merged: false,
          merge_commit_sha: null,
          head: { sha: HEAD },
          base: { ref: FOREIGN_BRANCH },
          user: { login: "github-actions[bot]" },
          number: FOREIGN_PR,
        }
        : url.includes("/check-runs")
        ? checkRunPage([
          checkRun("validate"),
          checkRun("verify-artifact"),
        ], 2)
        : url.includes("/git/ref/")
        ? { ref: `refs/heads/${FOREIGN_BRANCH}`, object: { sha: BASE } }
        : url.includes("/issues/")
        ? { state: "open" }
        : { default_branch: FOREIGN_BRANCH };
      return Promise.resolve(jsonResponse(payload));
    }) as typeof fetch;
    try {
      const surface = createHostedAutonomyGitHub("fixture-token", FOREIGN_REPO);
      assert.equal(await surface.readDefaultBranch(), FOREIGN_BRANCH);
      assert.equal(await surface.readBaseTip(FOREIGN_BRANCH), BASE);
      assert.equal(await surface.hasAllChecksGreen(HEAD), true);
      assert.equal(await surface.readIssueOpen(SHARED_ISSUE_NUMBER), true);
      const pull = await surface.readPull(FOREIGN_PR, FOREIGN_BRANCH);
      assert.equal(pull?.number, FOREIGN_PR);
      assert.equal(pull?.baseRef, FOREIGN_BRANCH);
      assert.ok(requests.length >= 5);
      assert.ok(requests.every(isForeignPath));
      assert.ok(!requests.some(isSelfPath));
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "hosted autonomy: a green foreign head merges and closes its own issue without a release",
  async () => {
    const requests: { method: string; url: string }[] = [];
    const original = globalThis.fetch;
    let mergedNow = false;
    globalThis.fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (!isForeignPath(url)) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      if (method === "PUT" && url.endsWith(`/pulls/${FOREIGN_PR}/merge`)) {
        mergedNow = true;
        return Promise.resolve(jsonResponse({ merged: true, sha: MERGE }));
      }
      if (
        method === "PATCH" && url.endsWith(`/issues/${SHARED_ISSUE_NUMBER}`)
      ) {
        return Promise.resolve(
          jsonResponse({ state: "closed", number: SHARED_ISSUE_NUMBER }),
        );
      }
      if (url.includes(`/pulls/${FOREIGN_PR}/files`)) {
        // The merge gate's protected-path listing (issue #158).
        return Promise.resolve(jsonResponse([
          { filename: "README.md", status: "modified" },
        ]));
      }
      if (url.includes(`/pulls/${FOREIGN_PR}`)) {
        return Promise.resolve(jsonResponse(
          mergedNow
            ? {
              state: "closed",
              merged: true,
              merge_commit_sha: MERGE,
              head: { sha: HEAD },
              base: { ref: FOREIGN_BRANCH },
              user: { login: "ubiquity-sentinel[bot]" },
              number: FOREIGN_PR,
            }
            : {
              state: "open",
              merged: false,
              merge_commit_sha: null,
              head: { sha: HEAD },
              base: { ref: FOREIGN_BRANCH },
              user: { login: "ubiquity-sentinel[bot]" },
              number: FOREIGN_PR,
            },
        ));
      }
      // Each listing is bound to the commit it was asked for: the merge gate
      // reads the head's runs and the reviewed base's (whose suites name the
      // checks the head must report too).
      const listed = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(url)?.[1];
      const payload = listed !== undefined
        ? checkRunPage([
          checkRun("validate", { head_sha: listed }),
          checkRun("verify-artifact", { head_sha: listed }),
        ], 2)
        : url.includes("/commits/")
        ? { parents: [{ sha: BASE }, { sha: HEAD }] }
        : url.includes("/compare/")
        ? {
          status: "ahead",
          base_commit: { sha: MERGE },
          merge_base_commit: { sha: MERGE },
        }
        : url.includes("/git/ref/")
        ? { ref: `refs/heads/${FOREIGN_BRANCH}`, object: { sha: BASE } }
        : url.includes("/actions/runs")
        ? { workflow_runs: [] }
        : url.includes("/issues/")
        ? {
          state: "open",
          number: SHARED_ISSUE_NUMBER,
          title: FOREIGN_TASK_TITLE,
          body: FOREIGN_TASK_BODY,
        }
        : { default_branch: FOREIGN_BRANCH };
      return Promise.resolve(jsonResponse(payload));
    }) as typeof fetch;
    try {
      const { rig } = await makeRig("autonomy-foreign-green", {
        repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
        resolver: (repository) =>
          createHostedAutonomyGitHub("fixture-token", repository),
      });
      const result = await run(rig);
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(result.reason, "closed_issues");
      assert.equal(rig.writes, 1);
      assert.deepEqual([...result.revisions], [MERGE]);
      assert.ok(
        result.actions.includes(`delivery:${FOREIGN_TARGET}:foreign_merged`),
      );
      assert.ok(result.actions.includes(`close:${FOREIGN_TARGET}:issue=120`));
      // Both the merge and the closure went to the record's OWN repository.
      assert.ok(requests.some((entry) =>
        entry.method === "PUT" &&
        entry.url.endsWith(
          `/repos/${FOREIGN_REPO.owner}/${FOREIGN_REPO.name}/pulls/${FOREIGN_PR}/merge`,
        )
      ));
      assert.ok(requests.some((entry) =>
        entry.method === "PATCH" &&
        entry.url.endsWith(
          `/repos/${FOREIGN_REPO.owner}/${FOREIGN_REPO.name}/issues/120`,
        )
      ));
      assert.ok(!requests.some((entry) => isSelfPath(entry.url)));
      // No release request is ever fabricated for a foreign repository.
      assert.deepEqual(await readRequests(rig), []);
      const read = await rig.state.readRepair();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("unreadable");
      }
      const record = read.value.snapshot.work[0];
      assert.equal(record.nextStep, "done");
      assert.equal(record.blocker, null);
      await Deno.remove(rig.tmp, { recursive: true });
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "hosted autonomy: a foreign head is green only when every check-run on it succeeded",
  async () => {
    const gate = async (checkRuns: unknown[]): Promise<boolean | null> => {
      const original = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.resolve(
          jsonResponse(checkRunPage(checkRuns, checkRuns.length)),
        )) as typeof fetch;
      try {
        return await createHostedAutonomyGitHub("fixture-token", FOREIGN_REPO)
          .hasAllChecksGreen(HEAD);
      } finally {
        globalThis.fetch = original;
      }
    };
    // Zero check-runs is not green: a foreign repository has no other
    // deterministic signal, so an unverified head is never delivered. It is
    // no evidence of a failure either: unreadable (null), never red.
    assert.equal(await gate([]), null);
    assert.equal(
      await gate([checkRun("validate", {
        status: "in_progress",
        conclusion: null,
      })]),
      false,
    );
    assert.equal(
      await gate([
        checkRun("validate", { status: "queued", conclusion: null }),
      ]),
      false,
    );
    assert.equal(
      await gate([
        checkRun("validate"),
        checkRun("verify-artifact", { conclusion: "failure" }),
      ]),
      false,
    );
    // A run reported on a different head is not a run on this one: the
    // listing is not bound to the head, so it is unreadable (null).
    assert.equal(await gate([checkRun("validate", { head_sha: SHA1 })]), null);
    // The foreign repository's own names are the gate: both green delivers.
    assert.equal(
      await gate([checkRun("validate"), checkRun("verify-artifact")]),
      true,
    );

    // The pass itself refuses a red or pending foreign head.
    const { rig } = await makeRig("autonomy-foreign-red", {
      repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
      pull: foreignPullFacts({
        state: "open",
        merged: false,
        mergeCommitSha: null,
      }),
      foreignCheckGreen: false,
    });
    const result = await run(rig);
    assert.equal(result.reason, "checks_pending");
    assert.equal(rig.merges, 0);
    assert.equal(rig.writes, 0);
    assert.equal(rig.closed.length, 0);
    assert.ok(
      result.actions.some((action) => action.endsWith("checks_pending")),
    );
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: issue 120 in two repositories never collides",
  async () => {
    const selfRecord120 = deliveryRecord({
      id: "issue-ubiquity-sentinel-120" as WorkItemId,
      source: {
        kind: "issue",
        id: String(SHARED_ISSUE_NUMBER),
        revision: SHA1,
      },
      related: { incidentId: null, issueNumber: SHARED_ISSUE_NUMBER },
      nextStep: "work",
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-120",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const foreignRecord120 = foreignRecord({
      nextStep: "work",
      target: {
        base: BASE,
        branch: `sentinel/repair/${FOREIGN_TARGET}`,
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const snapshot = repairSnapshot(
      [selfRecord120, foreignRecord120],
      [authorizingReceipt(), foreignReceipt()],
    );
    // Only the FOREIGN issue 120 is closed: sentinel's own 120 is untouched.
    assert.deepEqual(
      planHostedRetirements(
        snapshot,
        new Set([hostedIssueKey(FOREIGN_REPO, SHARED_ISSUE_NUMBER)]),
      ),
      [{
        id: FOREIGN_TARGET,
        issueNumber: SHARED_ISSUE_NUMBER,
        repository: FOREIGN_REPO,
      }],
    );
    // ...and the reverse: the foreign record survives sentinel's closure.
    assert.deepEqual(
      planHostedRetirements(
        snapshot,
        new Set([hostedIssueKey(SELF_REPO, SHARED_ISSUE_NUMBER)]),
      ),
      [{
        id: "issue-ubiquity-sentinel-120",
        issueNumber: SHARED_ISSUE_NUMBER,
        repository: SELF_REPO,
      }],
    );

    // Closure evidence is scoped the same way: an accepted self release and a
    // foreign merge are each only valid for their OWN repository's record.
    const closable = repairSnapshot(
      [
        deliveryRecord({
          id: "issue-ubiquity-sentinel-120" as WorkItemId,
          source: {
            kind: "issue",
            id: String(SHARED_ISSUE_NUMBER),
            revision: SHA1,
          },
          related: { incidentId: null, issueNumber: SHARED_ISSUE_NUMBER },
          target: {
            base: BASE,
            branch: "sentinel/repair/issue-ubiquity-sentinel-120",
            checkpoint: null,
            head: HEAD,
            pr: 51,
          },
        }),
        foreignRecord(),
      ],
      [
        // Sentinel's own issue 120 accepts ITS OWN task text, not the foreign
        // repository's identically numbered issue.
        authorizingReceipt({
          taskAcceptance: {
            issueNumber: SHARED_ISSUE_NUMBER,
            taskDigest: SELF_TASK_120.digest,
            verdict: "fulfilled",
            evidence: ["sentinel issue 120 is satisfied"],
          },
        }),
        foreignReceipt(),
      ],
    );
    const released = new Map([
      [hostedDeliveryKey(SELF_REPO, 51, HEAD, BASE), {}],
    ]);
    const proofRig = await makeRig("foreign-closure-proof", {
      repair: closable,
      pull: foreignPullFacts(),
    });
    const proofDeps = {
      state: proofRig.rig.state,
      githubFor: proofRig.rig.githubFor,
      clock: { now: () => 0 },
    };
    const proofScope = await createHostedAutonomyScopes(proofDeps).scopeFor(
      FOREIGN_REPO,
    );
    const proof = await resolveHostedDelivery(
      { deps: proofDeps, snapshot: closable, observedHead: SHA1 },
      closable.work[1],
      proofScope,
      foreignPullFacts(),
      "closure",
    );
    await Deno.remove(proofRig.rig.tmp, { recursive: true });
    assert.ok(proof);
    const foreignMerged = new Map([
      [hostedDeliveryKey(FOREIGN_REPO, FOREIGN_PR, HEAD, BASE), proof],
    ]);
    assert.deepEqual(
      planHostedClosures(
        closable,
        released,
        new Map(),
        closureTasks(closable.work),
      ),
      [{
        id: "issue-ubiquity-sentinel-120",
        issueNumber: SHARED_ISSUE_NUMBER,
        repository: SELF_REPO,
      }],
    );
    assert.deepEqual(
      planHostedClosures(
        closable,
        new Map(),
        foreignMerged,
        closureTasks(closable.work),
      ),
      [{
        id: FOREIGN_TARGET,
        issueNumber: SHARED_ISSUE_NUMBER,
        repository: FOREIGN_REPO,
      }],
    );

    // Runner level: closing the foreign issue 120 must not touch sentinel's
    // record for its own issue 120, and vice versa.
    const selfClosedIssues: number[] = [];
    const foreignClosedIssues: number[] = [];
    const { rig, github } = await makeRig("autonomy-issue-collision", {
      repair: repairSnapshot(
        [
          deliveryRecord({
            id: "issue-ubiquity-sentinel-120" as WorkItemId,
            source: {
              kind: "issue",
              id: String(SHARED_ISSUE_NUMBER),
              revision: SHA1,
            },
            related: { incidentId: null, issueNumber: SHARED_ISSUE_NUMBER },
            target: {
              base: BASE,
              branch: "sentinel/repair/issue-ubiquity-sentinel-120",
              checkpoint: null,
              head: HEAD,
              pr: 51,
            },
          }),
          foreignRecord(),
        ],
        // The self record carries no authorizing receipt at all; only the
        // foreign record has the evidence its own repository can supply.
        [foreignReceipt()],
      ),
      pull: foreignPullFacts(),
    });
    rig.githubFor = (repository) =>
      isSelfRepository(repository)
        ? {
          ...github,
          readPull: (number: number) =>
            Promise.resolve(number === 51 ? pullFacts() : null),
          closeIssue: (number: number) => {
            selfClosedIssues.push(number);
            return Promise.resolve(true);
          },
        }
        : {
          ...github,
          readDefaultBranch: () => Promise.resolve(FOREIGN_BRANCH),
          readPull: (number: number) =>
            Promise.resolve(number === FOREIGN_PR ? foreignPullFacts() : null),
          closeIssue: (number: number) => {
            foreignClosedIssues.push(number);
            return Promise.resolve(true);
          },
        };
    const result = await run(rig);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "closed_issues");
    assert.deepEqual(foreignClosedIssues, [SHARED_ISSUE_NUMBER]);
    assert.deepEqual(selfClosedIssues, []);
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const foreign = read.value.snapshot.work.find((record) =>
      record.id === FOREIGN_TARGET
    );
    const self = read.value.snapshot.work.find((record) =>
      record.id === "issue-ubiquity-sentinel-120"
    );
    assert.equal(foreign?.nextStep, "done");
    assert.equal(self?.nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);
