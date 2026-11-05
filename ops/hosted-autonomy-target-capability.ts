/**
 * Target capability pass (issue #332), run by the trusted launcher's hosted
 * maintenance pass, ahead of the runtime's next planning run.
 *
 * For each generic target (named policies never take it) the pass reads the
 * default-branch tip. A cached verdict for that exact branch, tip and runtime
 * generation is reused without reading the tree again; otherwise the tree
 * facts are read once, at exactly that tip, and re-evaluated
 * (`src/repair/target-capability.ts`).
 *
 * - An incapable target gets exactly one owner-action issue in its own
 *   repository, first body line `<!-- sentinel:skip -->` (intake never admits
 *   it) and second line the capability marker, listing what is missing. The
 *   issue number and the missing-set digest its body states are kept in the
 *   cached row, in the same expected-head write as the verdict: an unchanged
 *   missing set never creates, re-opens or edits anything; a changed one
 *   edits that issue. Before creating, the pass looks the marker up in one
 *   complete listing of the App's issues (including closed ones), so an issue whose recording
 *   write failed is adopted (and edited to the current list) instead of
 *   duplicated; an unreadable listing creates nothing. The runtime planner
 *   refuses every implementation admission of a target whose cached row is
 *   incapable, before any reservation.
 * - A capable target clears the issue binding and re-admits each record the
 *   no-CI park blocked (`capabilityReadmissionShapeV1`) by a status transition
 *   only: no counter, charge, intent or history is rewritten.
 *
 * All rows and re-admissions go out in ONE expected-head repair write; an
 * unreadable tip, tree or state writes nothing for that target. No target is
 * started past the deadline (the rows already settled are still written), and
 * the hosted glue never throws: the pass defers, it never fails the run. No
 * URL, body or credential reaches the action log.
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
import { HOSTED_RUNTIME_ID } from "../src/contracts/hosted-supervisor.ts";
import { isGenericTargetRepositoryV1 } from "../src/host/target-policy.ts";
import type { TargetTreeFactsV1 } from "../src/host/target-policy-generic.ts";
import {
  applyTargetCapabilityV1,
  cachedTargetCapabilityV1,
  capabilityReadmissionShapeV1,
  capabilityRowV1,
  evaluateTargetCapabilityV1,
  targetCapabilityCurrentV1,
  type TargetCapabilityIssuesV1,
  targetCapabilityIssueV1,
  type TargetCapabilityVerdictV1,
} from "../src/repair/target-capability.ts";
import {
  readReleaseSafely,
  readRepairSafely,
} from "./hosted-autonomy-state.ts";
import {
  hostedRepositoryKey,
  isHostedSelf,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import { createHostedAutonomyScopes } from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";

export type { TargetCapabilityIssuesV1 };

/** Wall-clock budget of the pass inside the maintenance pass. */
export const TARGET_CAPABILITY_PASS_BUDGET_MS = 60_000;

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
  /** Configured targets; absent means every repository with live work. */
  targets?: readonly RepositoryIdentityV1[];
  /** `owner/name` of every `sentinel.backup-ci-targets.json` row. */
  backupTargets: readonly string[];
  /** No target is started at or after this instant. */
  deadline?: number;
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

/**
 * Configured generic targets, including those with no records yet, plus
 * non-terminal work repositories, deduplicated in repository-key order.
 */
export function capabilityTargetsV1(
  snapshot: Pick<RepairStateSnapshotV1, "work">,
  configured: readonly RepositoryIdentityV1[] = [],
): RepositoryIdentityV1[] {
  const byKey = new Map<string, RepositoryIdentityV1>();
  for (
    const repository of [
      ...configured,
      ...snapshot.work.filter((record) => record.nextStep !== "done")
        .map((record) => record.repository),
    ]
  ) {
    if (isHostedSelf(repository) || !isGenericTargetRepositoryV1(repository)) {
      continue;
    }
    byKey.set(hostedRepositoryKey(repository), repository);
  }
  return [...byKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, repository]) => repository);
}

/** Issue actions for one incapable target; returns the new binding. */
async function settleOwnerIssue(
  issues: TargetCapabilityIssuesV1,
  issue: { title: string; body: string },
  name: string,
  current: { ownerIssue: number | null },
  actions: string[],
): Promise<{ ownerIssue: number; edited: boolean } | null> {
  let ownerIssue = current.ownerIssue;
  if (ownerIssue === null) {
    if (issues.findExisting === undefined) {
      actions.push(`capability:${name}:issue_lookup_absent`);
      return null;
    }
    const existing = await settle(() => issues.findExisting!());
    if (existing === null) {
      actions.push(`capability:${name}:issue_lookup_unreadable`);
      return null;
    }
    ownerIssue = existing.number;
    if (ownerIssue !== null) {
      actions.push(`capability:${name}:issue_adopted:${ownerIssue}`);
    }
  }
  if (ownerIssue === null) {
    const number = await settle(() => issues.create(issue));
    if (number === null) {
      actions.push(`capability:${name}:issue_create_unproven`);
      return null;
    }
    actions.push(`capability:${name}:issue_created:${number}`);
    return { ownerIssue: number, edited: true };
  }
  const updated = await settle(() => issues.update(ownerIssue!, issue));
  if (updated !== true) {
    actions.push(`capability:${name}:issue_update_unproven`);
    // An adopted issue is recorded even unedited: it is never re-created.
    return current.ownerIssue === null ? { ownerIssue, edited: false } : null;
  }
  actions.push(`capability:${name}:issue_updated:${ownerIssue}`);
  return { ownerIssue, edited: true };
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
  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
    return {
      status: "skipped",
      actions: ["capability:clock_invalid"],
      readmitted: [],
    };
  }
  const inBudget = () => {
    if (deps.deadline === undefined) return true;
    const at = deps.clock.now();
    return Number.isSafeInteger(at) && at < deps.deadline;
  };
  for (const repository of deps.targets ?? capabilityTargetsV1(snapshot)) {
    if (!isGenericTargetRepositoryV1(repository)) continue;
    const name = slug(repository);
    if (!inBudget()) {
      actions.push(`capability:${name}:deadline`);
      break;
    }
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
      verdict = { ...cached, backupCovered: backup.has(name.toLowerCase()) };
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
      if (issues === undefined) {
        actions.push(`capability:${name}:issue_capability_absent`);
      } else {
        const settled = await settleOwnerIssue(
          issues,
          targetCapabilityIssueV1(
            repository,
            tip.defaultBranch,
            tip.tip,
            verdict,
          ),
          name,
          { ownerIssue },
          actions,
        );
        if (settled !== null) {
          // An adopted issue that could not be edited keeps a stale digest,
          // so the next pass edits it again; it is never created twice.
          ownerIssueDigest = settled.edited
            ? verdict.missingDigest
            : ownerIssueDigest ?? STALE_ISSUE_DIGEST;
          ownerIssue = settled.ownerIssue;
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
  let next: RepairStateSnapshotV1;
  try {
    next = applyTargetCapabilityV1(snapshot, head, rows, readmit, now);
  } catch {
    return {
      status: "skipped",
      actions: [...actions, "capability:snapshot_invalid"],
      readmitted: [],
    };
  }
  const write = await settle(() => deps.state.writeRepair(next, head));
  if (write === null || !write.ok || write.value.status !== "applied") {
    // A created issue is adopted by its marker on the next pass.
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

/** A digest no missing set hashes to (the empty input's is never stored). */
const STALE_ISSUE_DIGEST = "0".repeat(64);

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

/**
 * The hosted maintenance glue: the runtime pointer generation from release
 * state, the targets with live work, each target's own surface (tip, tree
 * facts at that tip, capability issues) and the committed backup listing.
 * It shares the maintenance deadline and never throws: anything unreadable,
 * any write refusal or any fault only appends actions, so the run defers.
 */
export async function runHostedTargetCapabilityPass(
  deps: HostedAutonomyDepsV1,
  passDeadline: number = Number.POSITIVE_INFINITY,
  /**
   * The view targets are discovered from: the runner passes the read the
   * state-free passes already share, so a pass with no eligible target adds
   * no state read. The pass itself always re-reads `deps.state` for its
   * expected head.
   */
  discovery: StateReadView = deps.state,
): Promise<string[]> {
  try {
    // Only targets whose surface can read exact-tip facts and file the owner
    // issue take the pass; a surface without both costs nothing (no read,
    // no action), as with the base-repair pass.
    const repair = await readRepairSafely(discovery);
    if (repair === null || !repair.ok || repair.value.status !== "found") {
      return [];
    }
    const targets = capabilityTargetsV1(
      repair.value.snapshot,
      deps.capabilityTargets,
    ).filter(
      (repository) => {
        try {
          const surface = deps.githubFor(repository);
          return surface?.readTreeFacts !== undefined &&
            surface.capabilityIssues !== undefined;
        } catch {
          return false;
        }
      },
    );
    if (targets.length === 0) return [];
    const started = deps.clock.now();
    if (!Number.isSafeInteger(started)) return ["capability:clock_invalid"];
    const deadline = Math.min(
      started + TARGET_CAPABILITY_PASS_BUDGET_MS,
      passDeadline,
    );
    if (started >= deadline) return ["capability:deadline"];
    const release = await readReleaseSafely(deps.state);
    const runtime = release !== null && release.ok &&
        release.value.status === "found"
      ? release.value.snapshot.hostedRuntimes.find((row) =>
        row.id === HOSTED_RUNTIME_ID
      )
      : undefined;
    if (runtime === undefined) return ["capability:generation_unavailable"];
    const { scopeFor } = createHostedAutonomyScopes(deps);
    const result = await runTargetCapabilityPass({
      state: deps.state,
      clock: deps.clock,
      generation: runtime.generation,
      targets,
      backupTargets: deps.backupCiTargets ?? [],
      deadline,
      readTip: async (repository) => {
        const scope = await scopeFor(repository);
        if (scope.surface === null || scope.baseBranch === null) return null;
        const tip = await scope.surface.readBaseTip(scope.baseBranch);
        return tip !== null && /^[0-9a-f]{40}$/.test(tip)
          ? { defaultBranch: scope.baseBranch, tip: tip as GitSha }
          : null;
      },
      readFacts: async (repository, _branch, tip) => {
        const surface = (await scopeFor(repository)).surface;
        return surface?.readTreeFacts === undefined
          ? null
          : await surface.readTreeFacts(tip);
      },
      issuesFor: (repository) => {
        try {
          return deps.githubFor(repository)?.capabilityIssues;
        } catch {
          return undefined;
        }
      },
    });
    return result.actions;
  } catch {
    return ["capability:unexpected_error"];
  }
}
