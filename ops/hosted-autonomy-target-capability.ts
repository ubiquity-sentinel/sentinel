/**
 * Target capability pass (issue #332), run by the trusted launcher before
 * the runtime plans any model start.
 *
 * For each generic target (named policies never take it) the pass reads the
 * default-branch tip. A cached verdict for that exact branch, tip and runtime
 * generation is reused without reading the tree again; otherwise the tree
 * facts are read once and re-evaluated (`src/repair/target-capability.ts`).
 *
 * - An incapable target gets exactly one owner-action issue in its own
 *   repository, first body line `<!-- sentinel:skip -->` (intake never admits
 *   it), listing what is missing. The issue number and the missing-set digest
 *   its body states are kept in the cached row: an unchanged missing set
 *   never creates, re-opens or edits anything; a changed one edits that issue.
 *   The runtime planner refuses every implementation admission of a target
 *   whose cached row is incapable, before any reservation.
 * - A capable target clears the issue binding and re-admits each record the
 *   no-CI park blocked (`capabilityReadmissionShapeV1`) by a status transition
 *   only: no counter, charge, intent or history is rewritten.
 *
 * All rows and re-admissions go out in ONE expected-head repair write after
 * the GitHub reads/writes; an unreadable tip, tree or state writes nothing
 * for that target. An issue created before a failed or conflicting write is
 * reported (`capability:<repo>:issue_unrecorded`) so the owner can close a
 * duplicate; nothing is retried in the same pass. No URL, body or credential
 * reaches the action log.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import type {
  PortResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { TargetCapabilityRecordV1 } from "../src/contracts/target-capability.ts";
import { isGenericTargetRepositoryV1 } from "../src/host/target-policy.ts";
import type { TargetTreeFactsV1 } from "../src/host/target-policy-generic.ts";
import {
  applyTargetCapabilityV1,
  cachedTargetCapabilityV1,
  capabilityReadmissionShapeV1,
  capabilityRowV1,
  evaluateTargetCapabilityV1,
  targetCapabilityCurrentV1,
  targetCapabilityIssueV1,
  type TargetCapabilityVerdictV1,
} from "../src/repair/target-capability.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";
import { sameRepository } from "./hosted-autonomy-policy.ts";

/** Launcher-only owner-action issue writes in ONE target repository. */
export interface TargetCapabilityIssuesV1 {
  /** The created issue's number, or null when unproven. */
  create(input: { title: string; body: string }): Promise<number | null>;
  /** True only when GitHub confirms the exact new title and body. */
  update(
    number: number,
    input: { title: string; body: string },
  ): Promise<boolean>;
}

export interface TargetCapabilityPassDepsV1 {
  state: StateReadView & {
    writeRepair(
      next: RepairStateSnapshotV1,
      expectedHead: GitSha | null,
    ): Promise<PortResultV1<StateWriteResultV1>>;
  };
  clock: { now(): number };
  /** Trusted runtime pointer generation of this pass. */
  generation: number;
  /** Configured targets; only generic ones are checked. */
  targets: readonly RepositoryIdentityV1[];
  /** `owner/name` of every `sentinel.backup-ci-targets.json` row. */
  backupTargets: readonly string[];
  /** The default branch and its exact tip, or null when unreadable. */
  readTip(
    repository: RepositoryIdentityV1,
  ): Promise<{ defaultBranch: string; tip: GitSha } | null>;
  /** Tree facts at exactly `tip`, or null when unreadable. */
  readFacts(
    repository: RepositoryIdentityV1,
    defaultBranch: string,
    tip: GitSha,
  ): Promise<TargetTreeFactsV1 | null>;
  /** The issue capability of one target, or undefined when absent. */
  issuesFor(
    repository: RepositoryIdentityV1,
  ): TargetCapabilityIssuesV1 | undefined;
}

export interface TargetCapabilityPassResultV1 {
  status: "applied" | "unchanged" | "skipped" | "failed";
  actions: string[];
  /** Ids re-admitted by the applied write. */
  readmitted: string[];
}

const slug = (repository: RepositoryIdentityV1) =>
  `${repository.owner}/${repository.name}`;

async function settle<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

/** Run the capability pass once. */
export async function runTargetCapabilityPass(
  deps: TargetCapabilityPassDepsV1,
): Promise<TargetCapabilityPassResultV1> {
  const actions: string[] = [];
  const read = await readRepairSafely(deps.state);
  if (read === null || !read.ok || read.value.status !== "found") {
    return {
      status: "skipped",
      actions: ["capability:state_unavailable"],
      readmitted: [],
    };
  }
  const { snapshot } = read.value;
  const head = read.value.head as GitSha;
  const backup = new Set(deps.backupTargets.map((name) => name.toLowerCase()));
  const rows: TargetCapabilityRecordV1[] = [];
  const readmit: string[] = [];
  const created: string[] = [];
  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
    return {
      status: "skipped",
      actions: ["capability:clock_invalid"],
      readmitted: [],
    };
  }
  for (const repository of deps.targets) {
    if (!isGenericTargetRepositoryV1(repository)) continue;
    const name = slug(repository);
    const tip = await settle(() => deps.readTip(repository));
    if (tip === null) {
      actions.push(`capability:${name}:tip_unreadable`);
      continue;
    }
    const cached = cachedTargetCapabilityV1(snapshot, repository);
    let verdict: TargetCapabilityVerdictV1;
    let checkedAt: number;
    if (
      targetCapabilityCurrentV1(
        cached,
        tip.defaultBranch,
        tip.tip,
        deps.generation,
      )
    ) {
      verdict = cached;
      checkedAt = cached.checkedAt;
    } else {
      const facts = await settle(() =>
        deps.readFacts(repository, tip.defaultBranch, tip.tip)
      );
      if (facts === null) {
        actions.push(`capability:${name}:facts_unreadable`);
        continue;
      }
      verdict = await evaluateTargetCapabilityV1(
        facts,
        backup.has(name.toLowerCase()),
      );
      checkedAt = now;
    }
    let ownerIssue = cached?.ownerIssue ?? null;
    let ownerIssueDigest = cached?.ownerIssueDigest ?? null;
    if (verdict.capable) {
      ownerIssue = null;
      ownerIssueDigest = null;
      for (const record of snapshot.work) {
        if (
          sameRepository(record.repository, repository) &&
          capabilityReadmissionShapeV1(record)
        ) readmit.push(record.id);
      }
    } else if (ownerIssueDigest !== verdict.missingDigest) {
      const issues = deps.issuesFor(repository);
      const issue = targetCapabilityIssueV1(
        repository,
        tip.defaultBranch,
        tip.tip,
        verdict,
      );
      if (issues === undefined) {
        actions.push(`capability:${name}:issue_capability_absent`);
      } else if (ownerIssue === null) {
        const number = await settle(() => issues.create(issue));
        if (number === null) {
          actions.push(`capability:${name}:issue_create_unproven`);
        } else {
          ownerIssue = number;
          ownerIssueDigest = verdict.missingDigest;
          created.push(name);
          actions.push(`capability:${name}:issue_created:${number}`);
        }
      } else {
        const updated = await settle(() => issues.update(ownerIssue!, issue));
        if (updated === true) {
          ownerIssueDigest = verdict.missingDigest;
          actions.push(`capability:${name}:issue_updated:${ownerIssue}`);
        } else {
          actions.push(`capability:${name}:issue_update_unproven`);
        }
      }
    }
    const row = capabilityRowV1({
      repository,
      defaultBranch: tip.defaultBranch,
      tip: tip.tip,
      generation: deps.generation,
      verdict,
      ownerIssue,
      ownerIssueDigest,
      checkedAt,
    });
    if (cached === null || !sameRow(cached, row)) rows.push(row);
    actions.push(
      `capability:${name}:${verdict.capable ? "capable" : "incapable"}`,
    );
  }
  if (rows.length === 0 && readmit.length === 0) {
    return { status: "unchanged", actions, readmitted: [] };
  }
  const unrecorded = () =>
    created.forEach((name) =>
      actions.push(`capability:${name}:issue_unrecorded`)
    );
  let next: RepairStateSnapshotV1;
  try {
    next = applyTargetCapabilityV1(snapshot, head, rows, readmit, now);
  } catch {
    unrecorded();
    return {
      status: "skipped",
      actions: [...actions, "capability:snapshot_invalid"],
      readmitted: [],
    };
  }
  const write = await settle(() => deps.state.writeRepair(next, head));
  if (write === null || !write.ok || write.value.status !== "applied") {
    unrecorded();
    const reason = write?.ok === true ? write.value.status : "unavailable";
    return {
      status: write?.ok === true && write.value.status === "conflict"
        ? "skipped"
        : "failed",
      actions: [...actions, `capability:write_${reason}`],
      readmitted: [],
    };
  }
  for (const id of readmit) actions.push(`capability:readmitted:${id}`);
  return { status: "applied", actions, readmitted: readmit };
}

/** Rows are equal on every interpreted key (extras are never kept on write). */
function sameRow(
  left: TargetCapabilityRecordV1,
  right: TargetCapabilityRecordV1,
): boolean {
  const keys = [
    "defaultBranch",
    "tip",
    "generation",
    "capable",
    "missingDigest",
    "backupCovered",
    "ownerIssue",
    "ownerIssueDigest",
    "checkedAt",
  ] as const;
  return keys.every((key) => left[key] === right[key]) &&
    Object.keys(left).length === Object.keys(right).length;
}
