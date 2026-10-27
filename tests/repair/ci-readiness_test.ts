import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { ensureReviewFreshness } from "../../src/repair/loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import {
  ciRefreshAhead,
  currentCiValidation,
} from "../../src/repair/ci-readiness.ts";
import { PRE_REVIEW_CI_BOUND_MS } from "../../src/repair/ci-first-policy.ts";
import {
  releaseRequest,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { exactOpenPr } from "./loop-candidate-fixtures.ts";
import { seededSnapshot } from "./loop-rig.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";

function published(id: string, base = SHA1, pr = 7): WorkRecordV1 {
  return workRecord(id, {
    target: {
      base,
      head: SHA3,
      branch: candidateBranch(asWorkItemId(id)),
      pr,
      checkpoint: null,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
  });
}

async function freshness(record: WorkRecordV1, other: WorkRecordV1) {
  const clock = new FakeClock(T0 + 60_000);
  const state = new MemoryState();
  const configs = repairConfigs();
  const snapshot = seededSnapshot([record, other]);
  const written = await state.writeRepair(snapshot, null);
  assert.ok(written.ok && written.value.status === "applied");
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const github = new FakeGithub({
    baseSha: SHA2,
    candidateLifecycle: {
      refs: { [`refs/heads/${record.target.branch}`]: SHA3 },
      pullRequests: [exactOpenPr(7, SHA3, record.target.branch!)],
      prepareBaseRefresh: () => Promise.resolve(portOk(SHA3)),
    },
  });
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    configs,
    github,
    controllerSha: SHA1,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    budget: new RollingStartBudget({ state, clock, configs }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel({ head: SHA3, changedPaths: [] }),
  };
  const context: LoopContextV1 = {
    snapshot: read.value.snapshot,
    head: read.value.head,
    bounds: {
      modelCutoff: clock.now() + 60_000,
      runDeadline: clock.now() + 60_000,
    },
    executionBaseline: record,
  };
  const before = structuredClone(read.value.snapshot);
  const outcome = await ensureReviewFreshness(deps, context, record, 7);
  const after = await state.readRepair();
  assert.ok(after.ok && after.value.status === "found");
  return { outcome, before, after: after.value.snapshot };
}

Deno.test("pre-review refresh preserves another current-tip head's pending validation", async () => {
  const record = published("issue-1");
  const validating = published("issue-2", SHA2, 8);
  validating.wait = { reason: "ci_pending", since: T0, until: T0 + 300_000 };
  const out = await freshness(record, validating);
  assert.ok(out.outcome !== "closed_unmerged");
  assert.equal(out.outcome?.kind, "deferred");
  assert.deepEqual(
    out.after,
    out.before,
    "deferral writes no refresh, wait or charge",
  );
});

Deno.test("pre-review refresh does not wait behind a foreign target's validation", async () => {
  const record = published("issue-1");
  const other = published("issue-2", SHA2, 8);
  other.repository = { ...REPO, name: "passport.ubq.fi" };
  other.wait = { reason: "ci_pending", since: T0, until: T0 + 300_000 };
  const out = await freshness(record, other);
  assert.ok(out.outcome !== "closed_unmerged");
  assert.equal(out.outcome?.kind, "progress");
  assert.equal(out.after.work[0].intent?.kind, "base_refresh");
});

Deno.test("readiness releases expired, superseded and old-base waits", () => {
  const record = published("issue-1");
  const other = published("issue-2", SHA2, 8);
  other.wait = { reason: "ci_pending", since: T0, until: T0 + 300_000 };
  assert.equal(currentCiValidation(other, SHA2), true);
  assert.equal(
    ciRefreshAhead(seededSnapshot([record, other]), record, SHA2, T0 + 1000)
      ?.id,
    other.id,
  );
  other.updatedAt = T0 + PRE_REVIEW_CI_BOUND_MS;
  assert.equal(
    ciRefreshAhead(
      seededSnapshot([record, other]),
      record,
      SHA2,
      other.updatedAt,
    ),
    null,
    "existing CI bound releases the line",
  );
  other.target.base = SHA1;
  assert.equal(currentCiValidation(other, SHA2), false);
  assert.equal(
    ciRefreshAhead(seededSnapshot([record, other]), record, SHA2, T0 + 1000),
    null,
    "pending historical head holds no ready refresh",
  );
  other.target.base = SHA2;
  other.target.candidateState = { publishedHead: SHA1, preserved: null };
  assert.equal(
    ciRefreshAhead(seededSnapshot([record, other]), record, SHA2, T0 + 1000),
    null,
  );
});

Deno.test("only the oldest ready moved-base candidate refreshes before validation starts", () => {
  const first = published("issue-1");
  const next = published("issue-2", SHA1, 8);
  const snapshot = seededSnapshot([next, first]);
  assert.equal(ciRefreshAhead(snapshot, next, SHA2, T0 + 1000)?.id, first.id);
  assert.equal(ciRefreshAhead(snapshot, first, SHA2, T0 + 1000), null);
});

Deno.test("readiness: an exact booked delivery cannot hold a pending candidate's refresh", () => {
  const record = published("issue-2", SHA1, 8);
  record.wait = { reason: "ci_pending", since: T0, until: T0 + 300_000 };
  const booked = published("issue-1");
  booked.nextStep = "delivery";
  booked.wait = { reason: "unavailable", since: T0, until: null };
  const request = releaseRequest("booked-release", {
    source: {
      pullRequest: booked.target.pr,
      head: booked.target.head,
      base: booked.target.base,
      reviewRequestId: "review-req-booked",
      reviewReceiptId: null,
    },
  });
  const snapshot = seededSnapshot([record, booked], {
    releaseRequests: [request],
  });
  assert.equal(
    ciRefreshAhead(snapshot, record, SHA2, T0 + 1000),
    null,
    "disabled release bookkeeping is not an unmerged refresh contender",
  );
  const mismatches = [
    ["owner", {
      target: {
        ...request.target,
        repository: { ...REPO, owner: "other-owner" },
      },
    }],
    ["repository", {
      target: {
        ...request.target,
        repository: { ...REPO, name: "other-repository" },
      },
    }],
    ["installation", {
      target: {
        ...request.target,
        repository: { ...REPO, installationId: REPO.installationId + 1 },
      },
    }],
    ["environment", { target: { ...request.target, environment: "isolated" } }],
    ["pull request", { source: { ...request.source, pullRequest: 9 } }],
    ["head", { source: { ...request.source, head: SHA2 } }],
    ["base", { source: { ...request.source, base: SHA2 } }],
  ] as const;
  for (const [label, overrides] of mismatches) {
    assert.equal(
      ciRefreshAhead(
        {
          ...snapshot,
          releaseRequests: [releaseRequest("unrelated-release", overrides)],
        },
        record,
        SHA2,
        T0 + 1000,
      )?.id,
      booked.id,
      `a request for another ${label} cannot remove a live contender`,
    );
  }
});
