/**
 * Synthetic, sanitized backup CI records (docs/backup-ci-spec.md §6): a
 * Passport-shaped target, one workflow and check name, and builders for
 * every store record that produce exactly what the parsers accept. No value
 * here comes from a live store.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type BackupCiCalibrationV1,
  type BackupCiCommitFileV1,
  type BackupCiConclusionV1,
  type BackupCiDispatchedEntryV1,
  type BackupCiEntryKeyV1,
  backupCiEntrySortKey,
  type BackupCiEntryV1,
  type BackupCiNoEvidenceEntryV1,
  type BackupCiResultEntryV1,
  type BackupCiResultV1,
  type BackupCiSuspensionV1,
  type BackupCiTargetV1,
  backupCiUnitDigest,
  backupCiUnitId,
  type BackupCiUnitV1,
  type BackupCiWorkflowCoverageV1,
} from "../../src/contracts/backup-ci.ts";

export const OWNER = "ubiquity";
export const NAME = "passport.ubq.fi";
export const REPO = `${OWNER}/${NAME}` as const;
export const REPO_ID = 812345678;
export const TARGET: BackupCiTargetV1 = { repository: REPO, id: REPO_ID };
export const REPOSITORY = { owner: OWNER, name: NAME, id: REPO_ID };

const sha = (c: string) => c.repeat(40) as GitSha;
/** The head (the commit the check is about). */
export const H = sha("a");
/** The reviewed base. */
export const B = sha("b");
export const TREE = sha("c");
export const BLOB = sha("d");
export const LAUNCHER = sha("e");
/** The synthetic pull request merge M = [B, H]. */
export const M = sha("f");
export const OTHER = sha("9");
export const RUNNER = "0123456789abcdef";
export const RUNNER2 = "fedcba9876543210";
export const WORKFLOW = ".github/workflows/ci.yml";
export const CHECK = "deno";
export const T0 = Date.parse("2026-10-25T08:00:00Z");
export const DIGEST_A = "1".repeat(64);
export const DIGEST_B = "2".repeat(64);

export function key(
  over: Partial<BackupCiEntryKeyV1> = {},
): BackupCiEntryKeyV1 {
  const context = over.context ?? "push";
  return {
    context,
    workflowPath: WORKFLOW,
    checkName: CHECK,
    base: context === "pull_request" ? B : null,
    attempt: 1,
    ...over,
  };
}

function repositoryPayload() {
  return { full_name: REPO, name: NAME, owner: { login: OWNER } };
}

/** A valid unit for `k` on commit `commit` (default H), unit id computed. */
export function unit(
  k: BackupCiEntryKeyV1 = key(),
  over: {
    commit?: GitSha;
    runnerId?: string;
    mode?: "shadow" | "on";
    steps?: BackupCiUnitV1["steps"];
    event?: Record<string, unknown>;
  } = {},
): BackupCiUnitV1 {
  const commit = over.commit ?? H;
  const pr = k.context === "pull_request";
  const body: Omit<BackupCiUnitV1, "unitId" | "plan"> = {
    version: 1,
    kind: "sentinel_backup_ci_unit",
    purpose: k.attempt === 2 ? "confirm" : "stand_in",
    key: k,
    repository: {
      owner: OWNER,
      name: NAME,
      id: REPO_ID,
      defaultBranch: "development",
      private: true,
    },
    commit,
    exec: pr
      ? {
        commit: M,
        parents: [k.base as GitSha, commit],
        tree: TREE,
        synthetic: true,
      }
      : { commit, parents: [B], tree: TREE, synthetic: false },
    pullRequest: pr
      ? {
        number: 7,
        base: k.base as GitSha,
        baseRef: "development",
        headRef: "fix/7",
      }
      : null,
    ref: pr ? "refs/pull/7/merge" : "refs/heads/development",
    workflow: { path: k.workflowPath, blob: BLOB, name: "CI" },
    job: {
      key: "deno",
      matrix: null,
      checkName: k.checkName,
      runsOn: "ubuntu-latest",
      capMinutes: 60,
      targetTimeoutMinutes: null,
    },
    steps: over.steps ?? [
      {
        index: 0,
        actStepId: "0",
        kind: "uses_remote",
        uses: "actions/checkout@v6",
        condition: "none",
        continueOnError: false,
      },
      {
        index: 1,
        actStepId: "test",
        kind: "run",
        uses: null,
        condition: "none",
        continueOnError: false,
      },
    ],
    event: over.event ?? (pr
      ? {
        action: "synchronize",
        number: 7,
        pull_request: { number: 7, state: "open" },
        repository: repositoryPayload(),
        sender: { login: "ubiquity-sentinel[bot]" },
      }
      : {
        ref: "refs/heads/development",
        before: B,
        after: commit,
        repository: repositoryPayload(),
        pusher: { name: "ubiquity-sentinel[bot]" },
        sender: { login: "ubiquity-sentinel[bot]" },
        head_commit: { id: commit },
      }),
    neverStarted: {
      checkRunIds: [101],
      runIds: [201],
      cause: "account_billing",
    },
    native: null,
  };
  return {
    ...body,
    unitId: backupCiUnitId(body),
    plan: {
      runId: 9001,
      launcherSha: LAUNCHER,
      plannedAt: T0,
      mode: over.mode ?? "on",
      runnerId: over.runnerId ?? RUNNER,
    },
  };
}

export function dispatched(
  u: BackupCiUnitV1 = unit(),
): BackupCiDispatchedEntryV1 {
  return {
    state: "dispatched",
    key: u.key,
    mode: u.plan.mode,
    runnerId: u.plan.runnerId,
    unit: u,
    unitDigest: backupCiUnitDigest(u),
    tree: { artifactId: 3001, sha256: DIGEST_A },
    dispatchedAt: T0,
  };
}

export function result(
  k: BackupCiEntryKeyV1 = key(),
  over: {
    conclusion?: BackupCiConclusionV1;
    runnerId?: string;
    mode?: "shadow" | "evidence";
    commit?: GitSha;
    resultDigest?: string;
    unitDigest?: string;
    blob?: GitSha;
    legRunId?: number;
    at?: number;
  } = {},
): BackupCiResultEntryV1 {
  const commit = over.commit ?? H;
  const conclusion = over.conclusion ?? "success";
  const pr = k.context === "pull_request";
  return {
    state: "result",
    key: k,
    mode: over.mode ?? "evidence",
    runnerId: over.runnerId ?? RUNNER,
    purpose: k.attempt === 2 ? "confirm" : "stand_in",
    conclusion,
    unitDigest: over.unitDigest ?? DIGEST_A,
    resultDigest: over.resultDigest ?? DIGEST_B,
    startedAt: over.at ?? T0,
    completedAt: (over.at ?? T0) + 60_000,
    binding: {
      execCommit: pr ? M : commit,
      parents: pr ? [k.base as GitSha, commit] : [B],
      tree: TREE,
      workflowBlob: over.blob ?? BLOB,
      jobKey: "deno",
      matrix: null,
    },
    leg: {
      runId: over.legRunId ?? 5001,
      jobId: 6001,
      artifactId: 7001,
      launcherSha: LAUNCHER,
    },
    native: null,
    failure: conclusion === "success"
      ? null
      : { stepIndex: 1, excerpt: "error: test failed" },
    ingestedAt: (over.at ?? T0) + 120_000,
  };
}

export function noEvidence(
  k: BackupCiEntryKeyV1 = key(),
  over: Partial<BackupCiNoEvidenceEntryV1> = {},
): BackupCiNoEvidenceEntryV1 {
  return {
    state: "no_evidence",
    key: k,
    mode: "evidence",
    runnerId: RUNNER,
    reason: "leg_failed",
    legRuns: 1,
    firstAt: T0,
    lastAt: T0,
    nextAt: T0 + 15 * 60_000,
    final: false,
    ...over,
  };
}

export function coverage(
  over: Partial<BackupCiWorkflowCoverageV1> = {},
): BackupCiWorkflowCoverageV1 {
  return {
    path: WORKFLOW,
    blob: BLOB,
    event: "push",
    observedAt: T0,
    supported: true,
    reason: null,
    expected: [CHECK],
    ...over,
  };
}

/** A commit file of `commit` (default H), entries sorted as stored. */
export function commitFile(
  entries: BackupCiEntryV1[],
  over: Partial<BackupCiCommitFileV1> = {},
): BackupCiCommitFileV1 {
  return {
    version: 1,
    kind: "sentinel_backup_ci_commit",
    repository: { ...REPOSITORY },
    commit: H,
    workflows: [
      coverage(),
      coverage({ event: "pull_request" }),
    ],
    entries: [...entries].sort((a, b) =>
      backupCiEntrySortKey(a) < backupCiEntrySortKey(b) ? -1 : 1
    ),
    updatedAt: T0,
    ...over,
  };
}

/** A calibration where `runnerId` passes the gate (5 agreements, 1 red). */
export function calibration(
  runners: { runnerId: string; falseGreens?: number; agreements?: number }[] = [
    { runnerId: RUNNER },
  ],
): BackupCiCalibrationV1 {
  return {
    version: 1,
    kind: "sentinel_backup_ci_calibration",
    repository: { ...REPOSITORY },
    runners: runners.map((r) => ({
      runnerId: r.runnerId,
      agreements: r.agreements ?? 5,
      failureAgreements: 1,
      falseGreens: r.falseGreens ?? 0,
      falseReds: 0,
      samples: [],
    })),
    updatedAt: T0,
  };
}

export function suspension(
  over: Partial<BackupCiSuspensionV1> = {},
): BackupCiSuspensionV1 {
  return {
    version: 1,
    kind: "sentinel_backup_ci_suspension",
    scope: REPO,
    runnerIds: [RUNNER],
    reason: "false_green",
    since: T0,
    evidence: null,
    ...over,
  };
}

/** A valid leg result for `u`. */
export function legResult(
  u: BackupCiUnitV1 = unit(),
  over: Partial<BackupCiResultV1> = {},
): BackupCiResultV1 {
  return {
    version: 1,
    kind: "sentinel_backup_ci_result",
    unitId: u.unitId,
    unitDigest: backupCiUnitDigest(u),
    observed: {
      head: u.exec.commit,
      tree: u.exec.tree,
      parents: u.exec.parents,
      workflowBlob: u.workflow.blob,
      clean: true,
    },
    selftest: "passed",
    outcome: "success",
    reason: null,
    act: { exitCode: 0, jobResults: 1 },
    steps: u.steps.map((s) => ({ index: s.index, result: "success" })),
    failingStep: null,
    startedAt: T0,
    completedAt: T0 + 60_000,
    runner: {
      runnerId: u.plan.runnerId,
      imageOs: "ubuntu24",
      imageVersion: "20261020.1.0",
    },
    ...over,
  };
}

/** A JSON round trip: what a parser sees after the store wrote the value. */
export function wire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}
