/**
 * Target capability gate (issue #332): pure rules over the cached
 * `targetCapabilities` rows of the repair snapshot.
 *
 * - A target is capable exactly when its generic policy has merge test
 *   evidence (`createGenericTargetPolicyV1(...).mergeEvidence === "target_ci"`,
 *   i.e. a `pull_request` CI workflow). A runnable local verify command is
 *   reported but is not merge evidence (local-only verify is a separate
 *   future decision), and cross-org backup CI only stands in for never-started
 *   jobs of the target's OWN workflow, so neither makes a CI-less target
 *   capable. Both are recorded so the owner issue states the exact facts.
 * - A cached incapable verdict refuses every implementation admission of that
 *   repository (`targetCapabilityRefusesV1`), whatever its tip, until the
 *   trusted launcher re-verifies it at a moved tip or a new generation.
 * - Re-admission is a status transition only: `blocked` -> `work`, blocker
 *   and wait cleared, every counter, charge, intent and target kept.
 */
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  isKnownTargetCapabilityV1,
  TARGET_CAPABILITY_MISSING,
  targetCapabilityIdV1,
  type TargetCapabilityMissingV1,
  type TargetCapabilityRecordV1,
} from "../contracts/target-capability.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  createGenericTargetPolicyV1,
  NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER,
  type TargetTreeFactsV1,
} from "../host/target-policy-generic.ts";

/** The first body line every owner-action issue carries (intake skips it). */
export const SENTINEL_SKIP_MARKER = "<!-- sentinel:skip -->";

/** Second body line: identifies Sentinel's capability issue. */
export const TARGET_CAPABILITY_ISSUE_MARKER =
  "<!-- sentinel:target-capability -->";

/** Launcher-only owner-action issue reads/writes in ONE target repository. */
export interface TargetCapabilityIssuesV1 {
  /**
   * The lowest-numbered OPEN App-created issue carrying both markers
   * (`{number: null}` when none), from one complete listing; null when the
   * listing cannot be proven complete.
   */
  findExisting?(): Promise<{ number: number | null } | null>;
  /** The created issue's number, or null when unproven. */
  create(input: { title: string; body: string }): Promise<number | null>;
  /** True only when GitHub confirms the exact new title and body. */
  update(
    number: number,
    input: { title: string; body: string },
  ): Promise<boolean>;
}

/** The capability verdict derived from one tip's facts. */
export interface TargetCapabilityVerdictV1 {
  capable: boolean;
  missing: TargetCapabilityMissingV1[];
  missingDigest: string;
  backupCovered: boolean;
}

/** Evaluate one target's tree facts and backup listing. */
export async function evaluateTargetCapabilityV1(
  facts: TargetTreeFactsV1,
  backupCovered: boolean,
): Promise<TargetCapabilityVerdictV1> {
  const policy = createGenericTargetPolicyV1(facts);
  const capable = policy.mergeEvidence === "target_ci";
  const missing = TARGET_CAPABILITY_MISSING.filter((item) =>
    item === "pull_request_ci_workflow" ? !capable : !policy.localVerify
  );
  return {
    capable,
    missing,
    missingDigest: await canonicalStringifySha256(missing),
    backupCovered,
  };
}

/** The interpretable cached row of one repository, or null. */
export function cachedTargetCapabilityV1(
  snapshot: Pick<RepairStateSnapshotV1, "targetCapabilities">,
  repository: Pick<RepositoryIdentityV1, "installationId" | "owner" | "name">,
): TargetCapabilityRecordV1 | null {
  const id = targetCapabilityIdV1(repository);
  const row = (snapshot.targetCapabilities ?? []).find((entry) =>
    entry.id === id
  );
  return row !== undefined && isKnownTargetCapabilityV1(row) ? row : null;
}

/** True when a cached verdict refuses implementation admission here. */
export function targetCapabilityRefusesV1(
  snapshot: Pick<RepairStateSnapshotV1, "targetCapabilities">,
  repository: Pick<RepositoryIdentityV1, "installationId" | "owner" | "name">,
): boolean {
  return cachedTargetCapabilityV1(snapshot, repository)?.capable === false;
}

/** Whether the cached row still covers this tip and generation. */
export function targetCapabilityCurrentV1(
  row: TargetCapabilityRecordV1 | null,
  defaultBranch: string,
  tip: string,
  generation: number,
): row is TargetCapabilityRecordV1 {
  return row !== null && row.tip === tip &&
    row.defaultBranch === defaultBranch && row.generation === generation;
}

const MISSING_TEXT: Record<TargetCapabilityMissingV1, string> = {
  pull_request_ci_workflow:
    "A CI workflow under `.github/workflows/` that runs on `pull_request` (required: Sentinel merges only on the target's own CI evidence).",
  runnable_local_verify_command:
    "A runnable verify command for the detected toolchain (for example a `test` or `check` script/task).",
};

/** The plain-language owner-action issue for one missing set. */
export function targetCapabilityIssueV1(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  defaultBranch: string,
  tip: string,
  verdict: Pick<TargetCapabilityVerdictV1, "missing" | "backupCovered">,
): { title: string; body: string } {
  return {
    title: "Sentinel cannot verify changes here: CI is required",
    body: [
      SENTINEL_SKIP_MARKER,
      TARGET_CAPABILITY_ISSUE_MARKER,
      "",
      `Sentinel will not start repairs in \`${repository.owner}/${repository.name}\` because it cannot verify a change before merging. Checked \`${defaultBranch}\` at ${tip}.`,
      "",
      "Missing:",
      ...verdict.missing.map((item) => `- ${MISSING_TEXT[item]}`),
      "",
      verdict.backupCovered
        ? "This repository is listed for Sentinel's backup CI, but backup CI only runs jobs of this repository's own workflow, so it cannot stand in while no workflow exists."
        : "This repository is not listed for Sentinel's backup CI; backup CI would in any case only run jobs of this repository's own workflow.",
      "",
      "Once a pull_request workflow lands on the default branch, Sentinel re-checks automatically and resumes the parked work. This issue is updated only when the missing list changes.",
    ].join("\n"),
  };
}

/** A blocked record whose only reason is the target's missing CI. */
export function capabilityReadmissionShapeV1(record: WorkRecordV1): boolean {
  return record.nextStep === "blocked" &&
    record.blocker?.kind === "missing_evidence" &&
    record.blocker.message.startsWith(NO_CI_AND_NO_LOCAL_VERIFY_BLOCKER) &&
    record.intent === null && record.wait === null;
}

/** The updated capability row (a fresh write, no preserved extras). */
export function capabilityRowV1(input: {
  repository: RepositoryIdentityV1;
  defaultBranch: string;
  tip: GitSha;
  generation: number;
  verdict: TargetCapabilityVerdictV1;
  ownerIssue: number | null;
  ownerIssueDigest: string | null;
  checkedAt: number;
}): TargetCapabilityRecordV1 {
  return {
    id: targetCapabilityIdV1(input.repository),
    version: 1,
    repository: {
      owner: input.repository.owner,
      name: input.repository.name,
      installationId: input.repository.installationId,
    },
    defaultBranch: input.defaultBranch,
    tip: input.tip,
    generation: input.generation,
    capable: input.verdict.capable,
    missing: [...input.verdict.missing],
    missingDigest: input.verdict.missingDigest,
    backupCovered: input.verdict.backupCovered,
    ownerIssue: input.ownerIssue,
    ownerIssueDigest: input.ownerIssueDigest,
    checkedAt: input.checkedAt,
  };
}

/**
 * Apply capability rows and re-admissions to one snapshot (pure,
 * strict-parsed). Rows replace their id; re-admitted records keep every field
 * except `nextStep`, `blocker`, `wait` and `updatedAt`. A named record that
 * lost its re-admission shape throws, so the caller writes nothing.
 */
export function applyTargetCapabilityV1(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  rows: readonly TargetCapabilityRecordV1[],
  readmit: readonly string[],
  now: number,
): RepairStateSnapshotV1 {
  const byId = new Map(
    (snapshot.targetCapabilities ?? []).map((row) => [row.id, row]),
  );
  for (const row of rows) byId.set(row.id, row);
  const readmitted = new Set(readmit);
  let applied = 0;
  const work = snapshot.work.map((record) => {
    if (!readmitted.has(record.id)) return record;
    if (!capabilityReadmissionShapeV1(record)) {
      throw new TypeError("capability re-admission lost its park shape");
    }
    applied++;
    return {
      ...record,
      nextStep: "work" as const,
      blocker: null,
      wait: null,
      updatedAt: now,
    };
  });
  if (applied !== readmitted.size) {
    throw new TypeError("capability re-admission names no parked record");
  }
  const targetCapabilities = [...byId.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work,
    ...(targetCapabilities.length === 0 ? {} : { targetCapabilities }),
  });
}
