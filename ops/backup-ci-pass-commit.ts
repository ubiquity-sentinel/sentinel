/**
 * One candidate commit of the trusted pass (docs/backup-ci-spec.md §9.3
 * per-commit steps 1-5, §9.4): observations, the §5 observation rules and
 * the billing annotation, the pull request context, dedupe, materialization,
 * the workflow, tree and action rules, the exec commit and the event, and
 * finally the planned units. Refusals are recorded on the pass's changes
 * (`unsupported:*` final; `pr_*`/`fetch_failed` retried) when they bind a
 * key; coverage rows are recorded for every (path, event) the commit shows.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  BACKUP_CI_MAX_FILE_BYTES,
  type BackupCiCommitFileV1,
  type BackupCiContextV1,
  type BackupCiEntryKeyV1,
  type BackupCiNoEvidenceReasonV1,
  type BackupCiUnitV1,
  type BackupCiUnsupportedV1,
  parseBackupCiUnit,
} from "../src/contracts/backup-ci.ts";
import {
  type BackupCiActionCacheV1,
  resolveBackupCiActions,
} from "./backup-ci-actions.ts";
import { buildEventPayload } from "./backup-ci-act.ts";
import { BACKUP_CI_CONTEXT_GREP } from "./backup-ci-expressions.ts";
import { trustedCheckName } from "../src/repair/ci-rejection.ts";
import type { BackupCiBareRepo } from "./backup-ci-materialize.ts";
import {
  BACKUP_CI_BILLING_ANNOTATION,
  type BackupCiCandidateV1,
  backupCiDedupe,
  backupCiGroups,
  type BackupCiGroupV1,
  buildBackupCiUnit,
} from "./backup-ci-plan.ts";
import {
  type BackupCiPullV1,
  type BackupCiTargetReadsV1,
  readBackupCiObservations,
} from "./backup-ci-plan-reads.ts";
import type {
  BackupCiPassChanges,
  BackupCiPassDepsV1,
} from "./backup-ci-pass.ts";
import {
  backupCiExpected,
  type BackupCiWorkflowV1,
  planBackupCiJob,
  readBackupCiWorkflow,
  rootConfigFile,
} from "./backup-ci-workflow-map.ts";

type Repo = { owner: string; name: string; id: number };
export interface BackupCiPlannedUnitV1 {
  repository: Repo;
  unit: BackupCiUnitV1;
  bare: BackupCiBareRepo;
}

export const BACKUP_CI_MAX_TREE_FILES = 2_000;
const ANNOTATION_READS = 2;
const NATIVE = new Set(["success", "failure", "timed_out"]);
/** Tracked files the context scan reads (code, scripts and config). */
const INTEREST =
  /(?:^|\/)[^/.]+$|\.(?:[cm]?[jt]sx?|json5?|jsonc|sh|bash|zsh|py|rb|go|rs|toml|ya?ml|mk|vue|svelte|astro|php|pl|lua|ps1|bat|cmd|java|kt|gradle|swift)$/i;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Per-pass caches (remote actions; tree verdicts by commit). */
const actionCache: BackupCiActionCacheV1 = new Map();

export interface BackupCiCommitInputV1 {
  deps: BackupCiPassDepsV1;
  repo: Repo;
  info: { id: number; defaultBranch: string; private: boolean };
  reads: BackupCiTargetReadsV1;
  candidate: BackupCiCandidateV1;
  file: BackupCiCommitFileV1 | null;
  files: ReadonlyMap<string, BackupCiCommitFileV1 | null>;
  changes: BackupCiPassChanges;
}

/** Groups a candidate's purpose plans units for. */
function targetGroups(
  input: BackupCiCommitInputV1,
  groups: BackupCiGroupV1[],
): BackupCiGroupV1[] {
  const { candidate } = input;
  if (candidate.purpose === "confirm") {
    return groups.filter((g) =>
      g.workflowPath === candidate.key!.workflowPath &&
      g.checkName === candidate.key!.checkName
    );
  }
  if (candidate.purpose === "stand_in") {
    return groups.filter((g) => g.neverStarted);
  }
  const settled = (g: BackupCiGroupV1) =>
    g.started && g.latest.length > 0 &&
    g.latest.every((o) =>
      o.status === "completed" && NATIVE.has(o.conclusion ?? "")
    );
  if (candidate.purpose === "calibration") return groups.filter(settled);
  // Peers: a native group whose other side holds backup results for (P, N).
  const record = input.deps.snapshot?.work.find((r) =>
    r.id === candidate.recordId
  );
  if (record === undefined) return [];
  const other = candidate.commit === record.target.base
    ? record.target.head!
    : record.target.base;
  const otherFile = input.files.get(other);
  return groups.filter((g) =>
    settled(g) &&
    (otherFile?.entries.some((e) =>
      e.state === "result" && e.key.workflowPath === g.workflowPath &&
      e.key.checkName === g.checkName
    ) ?? false)
  );
}

/** Plans the units of one candidate commit (nothing on any unknown read). */
export async function planBackupCiCommit(
  input: BackupCiCommitInputV1,
): Promise<BackupCiPlannedUnitV1[]> {
  const { deps, repo, info, reads, candidate } = input;
  const runnerId = deps.runnerId!;
  const now = deps.now();
  const commit = candidate.commit;
  const obs = await readBackupCiObservations(reads, commit);
  if (obs === null) return [];
  if (
    candidate.purpose === "stand_in" &&
    !obs.latest.some((o) => o.notStarted === true)
  ) return [];
  const verdicts = backupCiGroups(obs);
  for (const v of verdicts) {
    if (!v.ok && v.reason !== "unknown") {
      deps.log(
        `backup-ci:${repo.owner}/${repo.name}@${
          commit.slice(0, 12)
        }:refused:${v.reason}`,
      );
    }
  }
  const groups = verdicts.flatMap((v) => v.ok ? [v.group] : []);
  const chosen = targetGroups(input, groups);
  if (chosen.length === 0) return [];
  const refuse = (
    key: BackupCiEntryKeyV1,
    reason: BackupCiNoEvidenceReasonV1,
  ) => {
    input.changes.refuse(repo, commit, key, deps.mode, runnerId, reason, now);
    if (reason.startsWith("unsupported:")) {
      deps.log(
        `backup-ci:${repo.owner}/${repo.name}@${commit.slice(0, 12)}:${
          trustedCheckName(key.checkName)
        }:${reason}`,
      );
    }
  };
  // Context: a confirmation keeps its key's; an open pull request is
  // pull_request (one unit covers its push observations too); else push.
  const context: BackupCiContextV1 = candidate.key?.context ??
    (candidate.pullRequest !== null ? "pull_request" : "push");
  const base: GitSha | null = context === "pull_request"
    ? candidate.key?.base ?? candidate.base
    : null;
  let pull: BackupCiPullV1 | null = null;
  const keyOf = (g: BackupCiGroupV1): BackupCiEntryKeyV1 => ({
    context,
    workflowPath: g.workflowPath,
    checkName: g.checkName,
    base,
    attempt: candidate.attempt,
  });
  if (context === "pull_request") {
    const number = candidate.pullRequest;
    if (number === null || base === null) return [];
    pull = await reads.pull(number);
    if (pull === null) return [];
    if (pull.state !== "open") {
      chosen.forEach((g) => refuse(keyOf(g), "pr_not_open"));
      return [];
    }
    if (pull.head.sha !== commit || pull.base.ref !== info.defaultBranch) {
      chosen.forEach((g) => refuse(keyOf(g), "pr_moved"));
      return [];
    }
    const compare = await reads.compare(base, commit);
    if (compare === null) return [];
    if (
      !(compare.status === "ahead" || compare.status === "identical") ||
      compare.behindBy !== 0
    ) {
      chosen.forEach((g) => refuse(keyOf(g), "unsupported:head_not_on_base"));
      return [];
    }
  }
  const plannable: BackupCiGroupV1[] = [];
  for (const group of chosen) {
    const key = keyOf(group);
    if (context === "push" && !group.events.includes("push")) {
      refuse(key, "pr_not_open");
      continue;
    }
    if (backupCiDedupe(input.file, key, deps.mode, runnerId, now) !== null) {
      continue;
    }
    if (group.neverStarted && candidate.purpose !== "peer") {
      let billed = false;
      for (
        const o of group.all.filter((x) => x.notStarted === true).slice(
          0,
          ANNOTATION_READS,
        )
      ) {
        const messages = await reads.annotations(o.checkRunId);
        if (messages === null) return [];
        if (messages.some((m) => BACKUP_CI_BILLING_ANNOTATION.test(m))) {
          billed = true;
          break;
        }
      }
      if (!billed) {
        refuse(key, "unsupported:not_account_cause");
        continue;
      }
    }
    plannable.push(group);
  }
  if (plannable.length === 0) return [];
  // A fresh directory per candidate: a unit planned earlier in this pass
  // may still need its own bare repository (one candidate never reuses or
  // removes another's).
  await Deno.mkdir(`${deps.workDir}/commits`, { recursive: true });
  const dir = `${await Deno.makeTempDir({
    dir: `${deps.workDir}/commits`,
    prefix: `${commit.slice(0, 12)}-`,
  })}/bare`;
  const bare = await deps.materialize(
    repo.owner,
    repo.name,
    base === null ? [commit] : [commit, base],
    dir,
  );
  if (bare === null) {
    plannable.forEach((g) => refuse(keyOf(g), "fetch_failed"));
    return [];
  }
  const treeH = await bare.treeOf(commit);
  if (treeH === null) return [];
  if (context === "pull_request") {
    const merge = await reads.pullMerge(candidate.pullRequest!);
    if (merge === null) return [];
    if (
      merge !== "absent" && merge.parents.length === 2 &&
      merge.parents[0] === base && merge.parents[1] === commit &&
      merge.tree !== treeH
    ) {
      plannable.forEach((g) => refuse(keyOf(g), "pr_moved"));
      return [];
    }
  }
  // Coverage of every (path, event) the commit shows.
  const workflows = new Map<
    string,
    { wf: BackupCiWorkflowV1; blob: GitSha | null }
  >();
  for (const group of groups) {
    if (workflows.has(group.workflowPath)) continue;
    const entry = await bare.entry(commit, group.workflowPath);
    const bytes = entry?.type === "blob"
      ? await bare.readBlob(entry.oid, BACKUP_CI_MAX_FILE_BYTES)
      : null;
    const wf: BackupCiWorkflowV1 = entry === null || bytes === null
      ? { ok: false, reason: "workflow_unreadable" }
      : readBackupCiWorkflow(group.workflowPath, entry.mode, bytes);
    workflows.set(group.workflowPath, { wf, blob: entry?.oid ?? null });
  }
  const covered = new Set<string>();
  for (const group of groups) {
    const { wf, blob } = workflows.get(group.workflowPath)!;
    for (const event of group.events) {
      const id = `${group.workflowPath}\n${event}`;
      if (blob === null || covered.has(id)) continue;
      covered.add(id);
      input.changes.of(repo, commit).coverage.push({
        path: group.workflowPath,
        blob,
        event,
        observedAt: now,
        supported: wf.ok,
        reason: wf.ok ? null : wf.reason,
        expected: backupCiExpected(wf).slice(0, 64),
      });
    }
  }
  const roots = await bare.rootNames(commit);
  if (roots === null) return [];
  let treeVerdict: BackupCiUnsupportedV1 | "fetch_failed" | null | undefined;
  const treeScan = async () => {
    if (treeVerdict !== undefined) return treeVerdict;
    const files = await bare.listFiles(commit);
    if (files === null) return treeVerdict = "fetch_failed";
    const interest = files.filter((f) =>
      INTEREST.test(f) && !WORKFLOW_FILE.test(f)
    );
    if (interest.length > BACKUP_CI_MAX_TREE_FILES) {
      return treeVerdict = "tree_too_large";
    }
    const hit = await bare.grep(commit, BACKUP_CI_CONTEXT_GREP, interest);
    return treeVerdict = hit === null
      ? "fetch_failed"
      : hit
      ? "context_reference"
      : null;
  };
  const parents = await bare.rawParents(commit);
  if (parents === null) return [];
  let exec: BackupCiUnitV1["exec"] = {
    commit,
    parents,
    tree: treeH,
    synthetic: false,
  };
  if (context === "pull_request") {
    const merge = await bare.syntheticMerge(base!, commit, now);
    if (merge === null) {
      plannable.forEach((g) => refuse(keyOf(g), "fetch_failed"));
      return [];
    }
    exec = {
      commit: merge,
      parents: [base!, commit],
      tree: treeH,
      synthetic: true,
    };
  }
  const local = async (path: string) =>
    await bare.readFile(commit, path, BACKUP_CI_MAX_FILE_BYTES);
  const out: BackupCiPlannedUnitV1[] = [];
  for (const group of plannable) {
    const key = keyOf(group);
    const { wf, blob } = workflows.get(group.workflowPath)!;
    if (!wf.ok || blob === null) {
      refuse(key, `unsupported:${wf.ok ? "workflow_unreadable" : wf.reason}`);
      continue;
    }
    if (rootConfigFile(roots)) {
      refuse(key, "unsupported:act_config_file");
      continue;
    }
    const planned = planBackupCiJob(wf, group.checkName);
    if (!planned.ok) {
      refuse(key, `unsupported:${planned.reason}`);
      continue;
    }
    const actions = await resolveBackupCiActions(
      planned.plan.uses,
      deps.actionSource(local),
      actionCache,
    );
    if (actions !== null) {
      refuse(key, `unsupported:${actions}`);
      continue;
    }
    const scan = await treeScan();
    if (scan === "fetch_failed") {
      refuse(key, "fetch_failed");
      continue;
    }
    if (scan !== null) {
      refuse(key, `unsupported:${scan}`);
      continue;
    }
    const repository = {
      owner: repo.owner,
      name: repo.name,
      id: repo.id,
      defaultBranch: info.defaultBranch,
      private: info.private,
    };
    const event = buildEventPayload({
      context,
      repository,
      commit,
      ref: `refs/heads/${candidate.branch}`,
      before: parents[0] ?? null,
      pull: pull === null ? null : {
        number: pull.number,
        draft: pull.draft,
        user: pull.user,
        head: { ...pull.head, sha: commit },
        base: { ...pull.base, sha: base! },
      },
    });
    const latest = group.latest[group.latest.length - 1];
    const neverStarted = group.neverStarted
      ? {
        checkRunIds: group.all.map((o) => o.checkRunId).sort((a, b) => a - b)
          .slice(0, 16),
        runIds: group.runIds.slice(0, 16),
        cause: "account_billing" as const,
      }
      : null;
    try {
      const unit = parseBackupCiUnit(
        JSON.parse(JSON.stringify(buildBackupCiUnit({
          purpose: candidate.purpose,
          key,
          repository,
          commit,
          exec,
          pullRequest: pull === null ? null : {
            number: pull.number,
            base: base!,
            baseRef: pull.base.ref,
            headRef: pull.head.ref,
          },
          ref: pull === null
            ? `refs/heads/${candidate.branch}`
            : `refs/pull/${pull.number}/merge`,
          workflow: { path: group.workflowPath, blob, name: wf.name },
          job: planned.plan.job,
          steps: planned.plan.steps,
          event,
          neverStarted,
          native:
            group.started && latest !== undefined && latest.conclusion !== null
              ? { checkRunId: latest.checkRunId, conclusion: latest.conclusion }
              : null,
        }, {
          runId: deps.runId,
          launcherSha: deps.launcherSha,
          plannedAt: now,
          mode: deps.mode,
          runnerId,
        }))),
      );
      out.push({ repository: repo, unit, bare });
    } catch {
      deps.log(
        `backup-ci:${repo.owner}/${repo.name}@${
          commit.slice(0, 12)
        }:unit_invalid`,
      );
    }
  }
  return out;
}
