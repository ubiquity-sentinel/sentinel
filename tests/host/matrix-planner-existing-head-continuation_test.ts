/** Owner throughput t10: custody_ready/preserved-null records plan continuation cells. */
import assert from "node:assert/strict";
import type {
  GitHubCheckV1,
  GitHubPullRequestV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-actions.ts";
import { isCiCorrectionFinding } from "../../src/repair/ci-rejection.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { MemoryState } from "../repair/helpers.ts";
import { reviewReceipt, T0, workRecord } from "../state/helpers.ts";
import { issue, rig } from "./matrix-actions-fixtures.ts";

const REPOSITORY = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

function headOf(issueNumber: number): GitSha {
  return String(issueNumber).repeat(40) as GitSha;
}

function greenCheck(head: GitSha): GitHubCheckV1 {
  return {
    name: "ci",
    status: "completed",
    conclusion: "success",
    head,
    startedAt: 1,
    completedAt: 2,
  };
}

function redCheck(head: GitSha): GitHubCheckV1 {
  return {
    name: "ci",
    status: "completed",
    conclusion: "failure",
    head,
    startedAt: 1,
    completedAt: 2,
  };
}

Deno.test(
  "matrix planner: custody_ready/preserved-null records plan correction cells bound to their PR heads",
  async () => {
    const r = await rig();
    try {
      const memory = new MemoryState();
      const release = await r.store.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      memory.setRelease(release.value.snapshot);
      const movedHead = "9".repeat(40) as GitSha;
      // Four records hold an existing published PR head with no durable
      // preserved candidate. Three still bind that exact head; the fourth's PR
      // head moved since custody.
      const seeded = [1, 2, 3, 4].map((issueNumber) => {
        const head = headOf(issueNumber);
        const id = `issue-ubiquity-sentinel-${issueNumber}`;
        return workRecord(id, {
          repository: REPOSITORY,
          id,
          source: { kind: "issue", id: String(issueNumber), revision: r.sha },
          related: { incidentId: null, issueNumber },
          controller: { sha: r.sha },
          failingRevision: null,
          counters: { attempts: 1, retries: 0, reviewRounds: 0 },
          target: {
            base: r.sha,
            branch: candidateBranch(
              asWorkItemId("issue-ubiquity-sentinel-" + issueNumber),
            ),
            checkpoint: null,
            head,
            pr: 900 + issueNumber,
            candidateState: { preserved: null, publishedHead: head },
          },
        });
      });
      const written = await memory.writeRepair(
        parseRepairStateSnapshotV1({
          version: "v1",
          kind: "repair_state_snapshot",
          stateHead: null,
          sequence: 1,
          updatedAt: r.clock.now(),
          incidents: [],
          evidence: [],
          work: seeded,
          reservations: [],
          reviews: [],
          replays: [],
          releaseRequests: [],
          githubCooldowns: [],
          attemptMemory: [],
          lessons: [],
        }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const source = r.github.get("ubiquity-sentinel/sentinel")!;
      const rows = [1, 2, 3, 4].map(issue);
      source.listOpenIssues = () => Promise.resolve(portOk([]));
      source.readIssue = (number) =>
        Promise.resolve(portOk(rows[number - 1] ?? null));
      source.readPullRequest = (number) => {
        const issueNumber = number - 900;
        const head = issueNumber === 4 ? movedHead : headOf(issueNumber);
        const pullRequest: GitHubPullRequestV1 = {
          number,
          title: "Sentinel repair",
          body: "Refs 1",
          state: "open",
          head,
          base: r.sha,
          mergeSha: null,
          headRef: `sentinel/repair/issue-ubiquity-sentinel-${issueNumber}`,
          baseRef: "development",
          author: null,
          createdAt: T0,
          updatedAt: T0,
          mergedAt: null,
          reviewDecision: "none",
        };
        return Promise.resolve(portOk(pullRequest));
      };
      // Only the three still-bound heads are red; every other head (including
      // the base) is green so the failure is attributed to the candidate.
      source.readChecks = (head) =>
        Promise.resolve(
          portOk({
            head,
            checks: [1, 2, 3].some((issueNumber) =>
                headOf(issueNumber) === head
              )
              ? [redCheck(head)]
              : [greenCheck(head)],
          }),
        );
      r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
        Promise.resolve(portOk([]));
      let modelCalls = 0;
      const model = {
        modelId: "gpt-reserve",
        runModel: () => {
          modelCalls++;
          return Promise.resolve(portError("unavailable", "fake model"));
        },
      };
      // First wave: each live-bound head is re-proved and takes the CI-first
      // gate's existing fix marker (uncharged deterministic progress). The
      // moved head is refused here and never marked.
      const marked = await runActionsMatrixHost({
        ...await r.job("existing-head-mark", "matrix_plan"),
        state: memory,
        model,
      });
      assert.ok("plan" in marked);
      assert.equal(
        marked.prepared,
        0,
        "a live CI observation never charges a start in the same wave",
      );
      const markedState = memory.repair!;
      for (const issueNumber of [1, 2, 3]) {
        const row = markedState.work.find((entry) =>
          entry.id === `issue-ubiquity-sentinel-${issueNumber}`
        )!;
        assert.deepEqual(
          row.wait,
          { reason: "backoff", since: r.clock.now(), until: r.clock.now() },
          "a live red candidate head takes the CI-first fix marker",
        );
        assert.equal(row.intent, null, "the marker start charges nothing");
        assert.equal(row.counters.retries, 0);
      }
      assert.equal(markedState.reservations.length, 0);
      r.clock.advance(1);
      const planned = await runActionsMatrixHost({
        ...await r.job("existing-head-plan", "matrix_plan"),
        state: memory,
        model,
      });
      assert.ok("plan" in planned);
      assert.equal(
        planned.prepared,
        3,
        "each custody_ready/preserved-null record with a bound head plans one correction cell",
      );
      assert.equal(modelCalls, 0);
      for (const cell of planned.plan.cells) {
        const issueNumber = Number(cell.taskId.split("-").pop());
        assert.equal(
          cell.request.checkoutBase,
          headOf(issueNumber),
          "the correction cell must continue the exact existing PR head",
        );
        assert.equal(cell.request.base, r.sha);
        assert.equal(cell.expectedBase, r.sha);
        assert.equal(cell.request.mergeBase, undefined);
        assert.equal(cell.request.reviewFindings?.length, 1);
        assert.ok(
          isCiCorrectionFinding(cell.request.reviewFindings![0]!),
          "the correction carries the live-derived CI finding shape",
        );
      }
      const state = memory.repair!;
      assert.equal(state.reservations.length, 3);
      assert.ok(
        state.reservations.every((row) => row.outcome === "reserved"),
      );
      const moved = state.work.find((row) =>
        row.id === "issue-ubiquity-sentinel-4"
      )!;
      assert.equal(moved.intent, null, "a moved PR head is never started");
      assert.equal(moved.wait, null, "a moved PR head is never marked");
      assert.equal(moved.blocker, null);
      assert.equal(
        state.work.filter((row) => row.intent?.kind === "implementation")
          .length,
        3,
      );
    } finally {
      await r.cleanup();
    }
  },
);

Deno.test(
  "matrix planner: a moved head with a red recorded head is refused before any state write",
  async () => {
    const r = await rig();
    try {
      const memory = new MemoryState();
      const release = await r.store.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      memory.setRelease(release.value.snapshot);
      const head = headOf(1);
      const id = "issue-ubiquity-sentinel-1";
      const seeded = workRecord(id, {
        repository: REPOSITORY,
        id,
        source: { kind: "issue", id: "1", revision: r.sha },
        related: { incidentId: null, issueNumber: 1 },
        controller: { sha: r.sha },
        failingRevision: null,
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
        target: {
          base: r.sha,
          branch: candidateBranch(asWorkItemId(id)),
          checkpoint: null,
          head,
          pr: 901,
          candidateState: { preserved: null, publishedHead: head },
        },
      });
      const written = await memory.writeRepair(
        parseRepairStateSnapshotV1({
          version: "v1",
          kind: "repair_state_snapshot",
          stateHead: null,
          sequence: 1,
          updatedAt: r.clock.now(),
          incidents: [],
          evidence: [],
          work: [seeded],
          reservations: [],
          reviews: [],
          replays: [],
          releaseRequests: [],
          githubCooldowns: [],
          attemptMemory: [],
          lessons: [],
        }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const before = structuredClone(memory.repair!.work[0]!);
      const source = r.github.get("ubiquity-sentinel/sentinel")!;
      source.listOpenIssues = () => Promise.resolve(portOk([]));
      source.readIssue = () => Promise.resolve(portOk(issue(1)));
      // The live pull request head moved since custody while the recorded head
      // itself is red: the CI-first marker must never be written for it.
      source.readPullRequest = (number) =>
        Promise.resolve(
          portOk({
            number,
            title: "Sentinel repair",
            body: "Refs 1",
            state: "open",
            head: "7".repeat(40) as GitSha,
            base: r.sha,
            mergeSha: null,
            headRef: "sentinel/repair/issue-ubiquity-sentinel-1",
            baseRef: "development",
            author: null,
            createdAt: T0,
            updatedAt: T0,
            mergedAt: null,
            reviewDecision: "none",
          } as GitHubPullRequestV1),
        );
      source.readChecks = (readHead) =>
        Promise.resolve(
          portOk({
            head: readHead,
            checks: [
              readHead === head ? redCheck(readHead) : greenCheck(readHead),
            ],
          }),
        );
      r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
        Promise.resolve(portOk([]));
      const model = {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("planner cannot infer")),
      };
      const planned = await runActionsMatrixHost({
        ...await r.job("red-moved-head", "matrix_plan"),
        state: memory,
        model,
      });
      assert.ok("plan" in planned);
      assert.equal(planned.prepared, 0);
      assert.deepEqual(
        memory.repair!.work[0],
        before,
        "a moved head is refused with no state write",
      );
      assert.equal(before.wait, null, "the seed carried no CI-first marker");
      assert.equal(memory.repair!.reservations.length, 0);
    } finally {
      await r.cleanup();
    }
  },
);

Deno.test(
  "matrix planner: a reviewed custody_ready head plans its continuation cell end to end",
  async () => {
    const r = await rig();
    try {
      const memory = new MemoryState();
      const release = await r.store.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      memory.setRelease(release.value.snapshot);
      const head = headOf(1);
      const id = "issue-ubiquity-sentinel-1";
      const seeded = workRecord(id, {
        repository: REPOSITORY,
        id,
        source: { kind: "issue", id: "1", revision: r.sha },
        related: { incidentId: null, issueNumber: 1 },
        controller: { sha: r.sha },
        failingRevision: null,
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
        target: {
          base: r.sha,
          branch: candidateBranch(asWorkItemId(id)),
          checkpoint: null,
          head,
          pr: 901,
          candidateState: { preserved: null, publishedHead: head },
        },
      });
      // A completed review already judged this exact PR/head/base: the row is
      // admitted on its red CI, not refused for being reviewed.
      const review = reviewReceipt("review-continuation", {
        repository: REPOSITORY,
        pullRequest: { number: 901, head, base: r.sha },
        outcome: "completed",
        observedReviewer: "chatgpt-codex-connector[bot]",
        resultId: "review-continuation-result",
        completedAt: T0 + 1500,
      });
      const written = await memory.writeRepair(
        parseRepairStateSnapshotV1({
          version: "v1",
          kind: "repair_state_snapshot",
          stateHead: null,
          sequence: 1,
          updatedAt: r.clock.now(),
          incidents: [],
          evidence: [],
          work: [seeded],
          reservations: [],
          reviews: [review],
          replays: [],
          releaseRequests: [],
          githubCooldowns: [],
          attemptMemory: [],
          lessons: [],
        }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const source = r.github.get("ubiquity-sentinel/sentinel")!;
      source.listOpenIssues = () => Promise.resolve(portOk([]));
      source.readIssue = () => Promise.resolve(portOk(issue(1)));
      source.readPullRequest = (number) =>
        Promise.resolve(
          portOk({
            number,
            title: "Sentinel repair",
            body: "Refs 1",
            state: "open",
            head,
            base: r.sha,
            mergeSha: null,
            headRef: "sentinel/repair/issue-ubiquity-sentinel-1",
            baseRef: "development",
            author: null,
            createdAt: T0,
            updatedAt: T0,
            mergedAt: null,
            reviewDecision: "none",
          } as GitHubPullRequestV1),
        );
      source.readChecks = (readHead) =>
        Promise.resolve(
          portOk({
            head: readHead,
            checks: [
              readHead === head ? redCheck(readHead) : greenCheck(readHead),
            ],
          }),
        );
      r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
        Promise.resolve(portOk([]));
      const model = {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("planner cannot infer")),
      };
      // First wave: the live red head takes its unchanged fix marker
      // (uncharged); the next wave is the correction admission.
      const marked = await runActionsMatrixHost({
        ...await r.job("reviewed-continuation-mark", "matrix_plan"),
        state: memory,
        model,
      });
      assert.ok("plan" in marked);
      assert.equal(marked.prepared, 0);
      r.clock.advance(1);
      const planned = await runActionsMatrixHost({
        ...await r.job("reviewed-continuation", "matrix_plan"),
        state: memory,
        model,
      });
      assert.ok("plan" in planned);
      assert.equal(
        planned.prepared,
        1,
        "a reviewed custody_ready/preserved-null record is planned, not deferred forever",
      );
      assert.equal(
        planned.plan.cells[0]!.request.checkoutBase,
        head,
        "the continuation cell binds the existing PR head",
      );
      assert.ok(
        isCiCorrectionFinding(
          planned.plan.cells[0]!.request.reviewFindings![0]!,
        ),
        "the continuation carries the live-derived CI finding",
      );
      const state = memory.repair!;
      assert.equal(state.reservations.length, 1);
      assert.equal(state.reservations[0]!.outcome, "reserved");
    } finally {
      await r.cleanup();
    }
  },
);

Deno.test(
  "matrix planner: a continuation head that moved after its marker is refused, not planned",
  async () => {
    const r = await rig();
    try {
      const memory = new MemoryState();
      const release = await r.store.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      memory.setRelease(release.value.snapshot);
      const movedHead = "8".repeat(40) as GitSha;
      const seeded = [1, 2].map((issueNumber) => {
        const head = headOf(issueNumber);
        const id = `issue-ubiquity-sentinel-${issueNumber}`;
        return workRecord(id, {
          repository: REPOSITORY,
          id,
          source: { kind: "issue", id: String(issueNumber), revision: r.sha },
          related: { incidentId: null, issueNumber },
          controller: { sha: r.sha },
          failingRevision: null,
          counters: { attempts: 1, retries: 0, reviewRounds: 0 },
          target: {
            base: r.sha,
            branch: candidateBranch(
              asWorkItemId("issue-ubiquity-sentinel-" + issueNumber),
            ),
            checkpoint: null,
            head,
            pr: 900 + issueNumber,
            candidateState: { preserved: null, publishedHead: head },
          },
        });
      });
      const written = await memory.writeRepair(
        parseRepairStateSnapshotV1({
          version: "v1",
          kind: "repair_state_snapshot",
          stateHead: null,
          sequence: 1,
          updatedAt: r.clock.now(),
          incidents: [],
          evidence: [],
          work: seeded,
          reservations: [],
          reviews: [],
          replays: [],
          releaseRequests: [],
          githubCooldowns: [],
          attemptMemory: [],
          lessons: [],
        }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const source = r.github.get("ubiquity-sentinel/sentinel")!;
      const rows = [1, 2].map(issue);
      source.listOpenIssues = () => Promise.resolve(portOk([]));
      source.readIssue = (number) =>
        Promise.resolve(portOk(rows[number - 1] ?? null));
      let movedPrHead: GitSha | null = null;
      source.readPullRequest = (number) => {
        const issueNumber = number - 900;
        const head = issueNumber === 2 && movedPrHead !== null
          ? movedPrHead
          : headOf(issueNumber);
        return Promise.resolve(
          portOk({
            number,
            title: "Sentinel repair",
            body: "Refs 1",
            state: "open",
            head,
            base: r.sha,
            mergeSha: null,
            headRef: `sentinel/repair/issue-ubiquity-sentinel-${issueNumber}`,
            baseRef: "development",
            author: null,
            createdAt: T0,
            updatedAt: T0,
            mergedAt: null,
            reviewDecision: "none",
          } as GitHubPullRequestV1),
        );
      };
      source.readChecks = (head) =>
        Promise.resolve(
          portOk({
            head,
            checks: [1, 2].some((issueNumber) => headOf(issueNumber) === head)
              ? [redCheck(head)]
              : [greenCheck(head)],
          }),
        );
      r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
        Promise.resolve(portOk([]));
      const model = {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("planner cannot infer")),
      };
      const marked = await runActionsMatrixHost({
        ...await r.job("moved-head-mark", "matrix_plan"),
        state: memory,
        model,
      });
      assert.ok("plan" in marked);
      assert.equal(marked.prepared, 0);
      const markedMoved = structuredClone(
        memory.repair!.work.find((row) =>
          row.id === "issue-ubiquity-sentinel-2"
        )!,
      );
      movedPrHead = movedHead;
      r.clock.advance(1);
      const planned = await runActionsMatrixHost({
        ...await r.job("moved-head-plan", "matrix_plan"),
        state: memory,
        model,
      });
      assert.ok("plan" in planned);
      assert.equal(
        planned.prepared,
        1,
        "only the head still published at its recorded SHA may be planned",
      );
      assert.equal(planned.plan.cells[0]!.request.checkoutBase, headOf(1));
      const state = memory.repair!;
      const moved = state.work.find((row) =>
        row.id === "issue-ubiquity-sentinel-2"
      )!;
      assert.equal(moved.intent, null, "a moved PR head is never started");
      assert.deepEqual(
        moved,
        markedMoved,
        "a moved PR head is re-proved BEFORE the CI-first gate, so its last marker is not rewritten",
      );
      assert.equal(
        state.reservations.filter((row) =>
          row.taskId === "issue-ubiquity-sentinel-2"
        ).length,
        0,
        "a moved PR head is never charged",
      );
    } finally {
      await r.cleanup();
    }
  },
);
