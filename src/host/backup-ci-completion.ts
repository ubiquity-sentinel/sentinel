/** Completion events request trusted reconciliation; they never supply CI evidence. */
import {
  BACKUP_CI_LEG_WORKFLOW_PATH,
  BACKUP_CI_WORKFLOW_PATH,
  type BackupCiDispatchedEntryV1,
  backupCiUnitDigest,
  parseBackupCiUnit,
} from "../contracts/backup-ci.ts";
import { HOSTED_CONTROLLER_REPOSITORY } from "../contracts/hosted-controller-deployment.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "../../ops/hosted-autonomy-policy.ts";
import { backupCiLegActorBinds } from "../../ops/backup-ci-ingest-verify.ts";

export const BACKUP_COMPLETION_REPOSITORY = HOSTED_CONTROLLER_REPOSITORY;
const ROOT = `/repos/${BACKUP_COMPLETION_REPOSITORY}`;
type Obj = Record<string, unknown>;
const row = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : null;
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const sha = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{40}$/.test(v);

export interface BackupCompletionApi {
  get(path: string): Promise<unknown | null>;
  send(
    method: "POST",
    path: string,
    body: Obj,
  ): Promise<{ status: number } | null>;
}

export type BackupCompletionOutcome = {
  decision: "requested" | "ignored" | "unavailable";
  reason: string;
};
const ignored = (reason: string): BackupCompletionOutcome => ({
  decision: "ignored",
  reason,
});
const unavailable = (reason: string): BackupCompletionOutcome => ({
  decision: "unavailable",
  reason,
});

function repositoryBinds(value: unknown, id: number): boolean {
  const repository = row(value);
  return repository?.id === id &&
    repository.full_name === BACKUP_COMPLETION_REPOSITORY;
}

function runBinds(
  value: unknown,
  id: number,
  workflow: Obj,
  repositoryId: number,
  branch: string,
  revision: string,
): value is Obj {
  const run = row(value);
  return run !== null && run.id === id && run.run_attempt === 1 &&
    run.workflow_id === workflow.id && run.path === workflow.path &&
    run.event === "workflow_dispatch" && run.head_branch === branch &&
    run.head_sha === revision &&
    repositoryBinds(run.repository, repositoryId) &&
    repositoryBinds(run.head_repository, repositoryId);
}

/** A fresh attempt and an existing trusted plan must both bind the observation. */
export async function routeBackupCiCompletion(
  event: unknown,
  deps: {
    api: BackupCompletionApi;
    dispatched(unitId: string): Promise<readonly BackupCiDispatchedEntryV1[]>;
  },
): Promise<BackupCompletionOutcome> {
  try {
    const payload = row(event), observed = row(payload?.workflow_run);
    if (
      payload?.action !== "completed" || observed === null ||
      observed.path !== BACKUP_CI_LEG_WORKFLOW_PATH ||
      !positive(observed.id) || observed.run_attempt !== 1 ||
      observed.status !== "completed" || !sha(observed.head_sha)
    ) return ignored("event_binding");
    const repository = row(await deps.api.get(ROOT));
    if (
      !positive(repository?.id) ||
      repository.full_name !== BACKUP_COMPLETION_REPOSITORY ||
      !repositoryBinds(payload.repository, repository.id)
    ) return ignored("repository_binding");
    const workflow = row(
      await deps.api.get(`${ROOT}/actions/workflows/backup-ci-leg.yml`),
    );
    if (
      !positive(workflow?.id) ||
      workflow.path !== BACKUP_CI_LEG_WORKFLOW_PATH ||
      !runBinds(
        observed,
        observed.id,
        workflow,
        repository.id,
        "sentinel-backup-legs",
        observed.head_sha,
      )
    ) return ignored("workflow_binding");
    const latest = row(
      await deps.api.get(`${ROOT}/actions/runs/${observed.id}`),
    );
    const native = row(
      await deps.api.get(`${ROOT}/actions/runs/${observed.id}/attempts/1`),
    );
    if (
      !runBinds(
        latest,
        observed.id,
        workflow,
        repository.id,
        "sentinel-backup-legs",
        observed.head_sha,
      ) ||
      !runBinds(
        native,
        observed.id,
        workflow,
        repository.id,
        "sentinel-backup-legs",
        observed.head_sha,
      ) || native.status !== "completed" || latest.status !== "completed" ||
      !backupCiLegActorBinds(native.triggering_actor)
    ) return ignored("attempt_binding");
    const title = /^sentinel-backup-ci-leg ([0-9a-f]{24})$/.exec(
      String(native.display_title),
    );
    if (title === null || observed.display_title !== native.display_title) {
      return ignored("unit_binding");
    }
    const entries = await deps.dispatched(title[1]);
    if (entries.length !== 1) return ignored("plan_not_pending");
    const entry = entries[0], unit = parseBackupCiUnit(entry.unit);
    if (
      entry.state !== "dispatched" || unit.unitId !== title[1] ||
      backupCiUnitDigest(unit) !== entry.unitDigest ||
      unit.plan.launcherSha !== native.head_sha
    ) return ignored("plan_binding");
    const plannerWorkflow = row(
      await deps.api.get(`${ROOT}/actions/workflows/backup-ci.yml`),
    );
    if (
      !positive(plannerWorkflow?.id) ||
      plannerWorkflow.path !== BACKUP_CI_WORKFLOW_PATH
    ) return ignored("planner_workflow_binding");
    const planner = await deps.api.get(
      `${ROOT}/actions/runs/${unit.plan.runId}/attempts/1`,
    );
    if (
      !runBinds(
        planner,
        unit.plan.runId,
        plannerWorkflow,
        repository.id,
        "sentinel-supervisor",
        unit.plan.launcherSha,
      )
    ) return ignored("planner_binding");
    // Dispatch even after a failed leg: only the protected ingest decides its
    // outcome, releases its occupied slot and creates any receipt.
    const sent = await deps.api.send(
      "POST",
      `${ROOT}/actions/workflows/backup-ci.yml/dispatches`,
      { ref: "sentinel-supervisor" },
    );
    return sent?.status === 204
      ? { decision: "requested", reason: "planned_leg_completed" }
      : unavailable("dispatch_unconfirmed");
  } catch {
    return unavailable("observation_unavailable");
  }
}

/** Only a newly committed usable receipt wakes the supervisor, never planning. */
export async function wakeBackupCiReceipt(
  result: { code: number; counts: Readonly<Record<string, number>> },
  api: BackupCompletionApi,
): Promise<BackupCompletionOutcome> {
  const advanced = result.counts.receipt_advanced ?? 0;
  if (result.code !== 0 || !positive(advanced)) {
    return ignored("no_new_receipt");
  }
  try {
    const repository = row(await api.get(ROOT));
    if (
      repository?.full_name !== BACKUP_COMPLETION_REPOSITORY ||
      repository.default_branch !== "development"
    ) return unavailable("dispatcher_binding");
    const sent = await api.send(
      "POST",
      `${ROOT}/actions/workflows/supervisor-dispatch.yml/dispatches`,
      { ref: "development" },
    );
    // The existing dispatcher skips active supervisors. Their finalize handoff
    // re-reads the durable receipt; the idle path starts a fresh protected run.
    return sent?.status === 204
      ? { decision: "requested", reason: "receipt_advanced" }
      : unavailable("dispatch_unconfirmed");
  } catch {
    return unavailable("observation_unavailable");
  }
}

/** This controller receives only its own CI events, never foreign check events. */
export async function routeControllerCiCompletion(
  event: unknown,
  api: BackupCompletionApi,
): Promise<BackupCompletionOutcome> {
  try {
    const payload = row(event), observed = row(payload?.workflow_run);
    if (
      payload?.action !== "completed" || observed === null ||
      observed.path !== ".github/workflows/ci.yml" ||
      !positive(observed.id) || !positive(observed.run_attempt) ||
      observed.status !== "completed" || observed.event !== "pull_request" ||
      !sha(observed.head_sha) ||
      typeof observed.head_branch !== "string" ||
      !observed.head_branch.startsWith("sentinel/repair/")
    ) return ignored("event_binding");
    const repository = row(await api.get(ROOT));
    const workflow = row(await api.get(`${ROOT}/actions/workflows/ci.yml`));
    if (
      !positive(repository?.id) ||
      repository.full_name !== BACKUP_COMPLETION_REPOSITORY ||
      repository.default_branch !== "development" ||
      !repositoryBinds(payload.repository, repository.id) ||
      !positive(workflow?.id) || workflow.path !== observed.path
    ) return ignored("workflow_binding");
    const repositoryId = repository.id;
    const binds = (run: Obj | null) =>
      run !== null && run.id === observed.id &&
      run.run_attempt === observed.run_attempt && run.status === "completed" &&
      run.workflow_id === workflow.id && run.path === workflow.path &&
      run.event === "pull_request" &&
      run.head_branch === observed.head_branch &&
      run.head_sha === observed.head_sha &&
      repositoryBinds(run.repository, repositoryId) &&
      repositoryBinds(run.head_repository, repositoryId);
    const latest = row(await api.get(`${ROOT}/actions/runs/${observed.id}`));
    const native = row(
      await api.get(
        `${ROOT}/actions/runs/${observed.id}/attempts/${observed.run_attempt}`,
      ),
    );
    if (!binds(observed) || !binds(latest) || !binds(native)) {
      return ignored("attempt_binding");
    }
    const pulls = native!.pull_requests;
    if (!Array.isArray(pulls) || pulls.length !== 1) {
      return ignored("pull_binding");
    }
    const number = row(pulls[0])?.number;
    if (!positive(number)) return ignored("pull_binding");
    const pull = row(await api.get(`${ROOT}/pulls/${number}`));
    const head = row(pull?.head), base = row(pull?.base);
    if (
      pull?.number !== number || pull.state !== "open" ||
      row(pull.user)?.login !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
      head?.sha !== observed.head_sha || head.ref !== observed.head_branch ||
      base?.ref !== repository.default_branch ||
      !repositoryBinds(head.repo, repository.id) ||
      !repositoryBinds(base.repo, repository.id)
    ) return ignored("pull_binding");
    const sent = await api.send(
      "POST",
      `${ROOT}/actions/workflows/supervisor-dispatch.yml/dispatches`,
      { ref: "development" },
    );
    return sent?.status === 204
      ? { decision: "requested", reason: "current_head_ci_completed" }
      : unavailable("dispatch_unconfirmed");
  } catch {
    return unavailable("observation_unavailable");
  }
}
