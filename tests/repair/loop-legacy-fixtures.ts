/** Legacy lost-candidate proof and bounded cycle fixtures. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type {
  GitHubPort,
  LegacyBaseRefreshLossProofV1,
} from "../../src/contracts/ports.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
} from "../../src/repair/keys.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop.ts";
import {
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { LOCAL_SENTINEL_REPO, localScopeConfig, SHA4 } from "./loop-rig.ts";

export const LEGACY_ISSUE = 48;
export const LEGACY_PR = 51;
export const LEGACY_TASK = asWorkItemId("issue-48");
export const LEGACY_BRANCH = candidateBranch(LEGACY_TASK);
export const LEGACY_B0 = SHA1;
export const LEGACY_B1 = SHA2;
export const LEGACY_H1 = SHA3;
export const LEGACY_H0 = SHA4;
export const LEGACY_INTENT_KEY = baseRefreshIntentKey(
  LEGACY_PR,
  LEGACY_H1,
  LEGACY_B1,
);
export const LEGACY_REVIEW_ID = `review-receipt:${LEGACY_PR}:${LEGACY_H0}`;
export const LEGACY_DETAIL =
  "legacy base-refresh candidate is missing; predecessor head pending";

/** Original unprepared legacy base-refresh intent for one task id. */
export function legacyLossIntent(id: string, pr = LEGACY_PR) {
  const branch = candidateBranch(asWorkItemId(id));
  return {
    kind: "base_refresh" as const,
    key: baseRefreshIntentKey(pr, LEGACY_H1, LEGACY_B1),
    startedAt: T0,
    branch,
    expectedHead: LEGACY_H1,
    observedBase: LEGACY_B1,
    pr,
    requestId: null,
    resultId: null,
  };
}

/** Self scope-0 issue work-record overrides for one legacy-loss tuple. */
export function legacyLossOverrides(
  id: string,
  issueNumber: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const taskId = asWorkItemId(id);
  const branch = candidateBranch(taskId);
  return {
    repository: LOCAL_SENTINEL_REPO,
    source: { kind: "issue", id: String(issueNumber), revision: LEGACY_B0 },
    related: { incidentId: null, issueNumber },
    target: {
      base: LEGACY_B0,
      branch,
      checkpoint: { branch, sha: LEGACY_H1 },
      head: LEGACY_H1,
      pr: LEGACY_PR,
    },
    nextStep: "work",
    counters: { attempts: 3, retries: 0, reviewRounds: 1 },
    evidence: [{
      kind: "review_receipt",
      ref: `artifact://sentinel/legacy-loss/${issueNumber}`,
    }],
    intent: legacyLossIntent(id),
    ...extra,
  };
}

export function legacyLossWork(
  id: string,
  issueNumber: number,
  extra: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(id, legacyLossOverrides(id, issueNumber, extra));
}

/** Original submitted charge for the seeded attempts-3 legacy operation. */
export function legacyLossCharge(
  id = "res-3",
  overrides: Record<string, unknown> = {},
) {
  return reservation(id, {
    repository: LOCAL_SENTINEL_REPO,
    taskId: LEGACY_TASK,
    attempt: 3,
    head: LEGACY_B0,
    purpose: "retry",
    outcome: "submitted",
    settledAt: T0 + 500,
    ...overrides,
  });
}

/** Completed review bound to one exact repository/PR/head/base tuple. */
export function legacyLossReview(
  id: string,
  head: GitSha,
  base: GitSha,
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return reviewReceipt(id, {
    repository: LOCAL_SENTINEL_REPO,
    pullRequest: { number: LEGACY_PR, head, base },
    outcome: "completed",
    resultId: "result-h0",
    observedReviewer: "chatgpt-codex-connector[bot]",
    submittedAt: T0,
    completedAt: T0 + 1000,
    observedAt: T0 + 1001,
    findings: [{
      id: "finding-h0",
      severity: "P0",
      path: "src/app.ts",
      message: "legacy correction finding",
      fingerprint: "a".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }],
    // The lost correction followed a blocking rejection: only an unresolved
    // P0 finding rejects a head and sends it back to implementation (owner
    // directive 2026-10-24).
    unresolvedSeverities: ["P0"],
    ...overrides,
  });
}

/** Runtime proof value bound to one exact task and authoritative state head. */
export function legacyLossProof(
  taskId: WorkItemId,
  stateHead: GitSha,
  overrides: Partial<LegacyBaseRefreshLossProofV1> = {},
): LegacyBaseRefreshLossProofV1 {
  return {
    taskId,
    repository: { ...LOCAL_SENTINEL_REPO },
    stateHead,
    shape: "legacy_base_refresh",
    lostBase: LEGACY_B0,
    lostHead: LEGACY_H1,
    predecessorHead: LEGACY_H0,
    branch: candidateBranch(taskId),
    pr: LEGACY_PR,
    intentKey: LEGACY_INTENT_KEY,
    reviewId: LEGACY_REVIEW_ID,
    ...overrides,
  };
}

/** The authoritative repair state head (never `snapshot.stateHead`). */
export async function repairStateHead(
  state: RepairCycleDepsV1["state"],
): Promise<GitSha> {
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") {
    throw new Error("no repair state");
  }
  return read.value.head;
}

/**
 * Bounded direct-cycle driver for the legacy-loss bridge tests. `makeRig.run`
 * fixes its step limit at 16; these tests assert one persisted transition per
 * cycle, so they call the real loop with the same explicit self scope-0
 * config/budget pair the rig uses. The generic rig API is not grown.
 */
export function legacyLossCycles(
  base: Pick<
    RepairCycleDepsV1,
    "clock" | "state" | "github" | "incidents" | "replay" | "model"
  >,
) {
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  configs.push(localScopeConfig(configs[0]));
  const budget = new RollingStartBudget({
    clock: base.clock,
    state: base.state,
    configs,
  });
  const githubCooldown = new DurableGitHubCooldownGate({
    state: base.state,
    clock: base.clock,
  });
  const run = (stepLimit: number) =>
    runRepairCycle({
      clock: base.clock,
      state: base.state,
      configs,
      controllerSha: SHA1,
      github: base.github,
      githubCooldown,
      incidents: base.incidents,
      replay: base.replay,
      model: base.model,
      budget,
    }, { deadline: base.clock.now() + 60 * 60_000, stepLimit });
  return { run };
}

/** Cheap MemoryState bridge rig with the self scope-0 config pair. */
export function legacyLossMemory() {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const github: GitHubPort = new FakeGithub({ baseSha: LEGACY_B0 });
  const incidents = new FakeIncidents({ summaries: [], evidence: null });
  const replay = new FakeReplay();
  const model = new FakeModel({
    head: LEGACY_H1,
    changedPaths: ["src/app.ts"],
  });
  const { run } = legacyLossCycles({
    clock,
    state,
    github,
    incidents,
    replay,
    model,
  });
  const snapshot = async (): Promise<RepairStateSnapshotV1> => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  return { clock, state, github, model, run, snapshot };
}

/** Blocked tuple the discovery CAS writes (before any restoration). */
export function legacyLossBlockedExtras() {
  return {
    nextStep: "blocked",
    blocker: {
      kind: "missing_evidence",
      message: LEGACY_DETAIL,
      since: T0,
    },
  };
}
