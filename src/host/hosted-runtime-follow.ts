import type { HttpTransportV1 } from "../github/http.ts";
import {
  activeSupervisorRuns,
  FOLLOW_DEVELOPMENT_REF,
  FOLLOW_LAUNCHER_REF,
  FOLLOW_REPOSITORY,
  FOLLOW_STATE_REF,
  FollowError,
  HostedRuntimeFollowApi,
  positive,
  record,
  sha,
} from "./hosted-runtime-follow-api.ts";
import {
  FOLLOW_REQUIRED_CHECK,
  type FollowCiProof,
  readFollowCi,
  recheckFollowCi,
} from "./hosted-runtime-follow-ci.ts";
import { readFollowState } from "./hosted-runtime-follow-state.ts";

export interface HostedRuntimeFollowJournal {
  observedDevelopmentSha: string | null;
  previousLauncherSha: string | null;
  installedRevision: string | null;
  candidateSha: string | null;
  ciRunId: number | null;
  ciAttempt: number | null;
  checkName: string;
  decision: "advanced" | "unchanged" | "dry_run" | "deferred" | "failed";
  reason: string;
}

export interface HostedRuntimeFollowResult {
  journal: HostedRuntimeFollowJournal;
  launcherSha: string | null;
  safeToDispatch: boolean;
  exitCode: number;
}

export interface HostedRuntimeFollowDeps {
  http: HttpTransportV1;
  token: string;
  /** Only the exact repository-variable value `on` permits a write. */
  flag?: string;
  log?: (journal: HostedRuntimeFollowJournal) => void;
  maxDepth?: number;
  deadlineMs?: number;
  maxPages?: number;
}

/** The follow step has no state writer, App identity, model or promotion port. */
export async function runHostedRuntimeFollow(
  deps: HostedRuntimeFollowDeps,
): Promise<HostedRuntimeFollowResult> {
  const journal: HostedRuntimeFollowJournal = {
    observedDevelopmentSha: null,
    previousLauncherSha: null,
    installedRevision: null,
    candidateSha: null,
    ciRunId: null,
    ciAttempt: null,
    checkName: FOLLOW_REQUIRED_CHECK,
    decision: "deferred",
    reason: "not_observed",
  };
  const api = new HostedRuntimeFollowApi(
    deps.http,
    deps.token,
    deps.deadlineMs,
    deps.maxPages,
  );
  let launcherSha: string | null = null;
  let safeToDispatch = false;
  let writeSubmitted = false;
  try {
    if (deps.token === "") throw new FollowError("missing_token");
    const repository = record(await api.get(""));
    if (
      repository.full_name !== FOLLOW_REPOSITORY ||
      typeof repository.node_id !== "string" || repository.node_id.length === 0
    ) {
      throw new FollowError("repository_identity_mismatch");
    }
    const repositoryId = positive(repository.id);
    journal.observedDevelopmentSha = await api.ref(FOLLOW_DEVELOPMENT_REF);
    journal.previousLauncherSha = await api.ref(FOLLOW_LAUNCHER_REF);
    launcherSha = journal.previousLauncherSha;
    safeToDispatch = true;
    const state = await readFollowState(api);
    journal.installedRevision = state.installedRevision;
    if (state.executionInFlight) throw new FollowError("execution_in_flight");
    if (state.installationUnresolved) {
      throw new FollowError("installation_unresolved");
    }
    if ((await activeSupervisorRuns(api)).length > 0) {
      throw new FollowError("supervisor_in_flight");
    }
    const chain = await firstParentChain(
      api,
      journal.observedDevelopmentSha,
      launcherSha,
      deps.maxDepth ?? 400,
    );
    let selected: FollowCiProof | null = null;
    // A candidate whose workflow files differ from the launcher's needs a
    // workflow-capable owner push: skip it (an older candidate may still
    // qualify) and defer, never attempt a ref write GitHub refuses.
    let launcherWorkflows: string | null | undefined;
    let workflowChanged = false;
    for (const candidate of chain) {
      if (candidate === launcherSha || state.failedRevisions.has(candidate)) {
        continue;
      }
      const proof = await readFollowCi(api, candidate, repositoryId);
      if (
        proof === null ||
        !await api.ancestor(state.installedRevision, candidate)
      ) continue;
      if (launcherWorkflows === undefined) {
        launcherWorkflows = await api.workflowsTree(launcherSha);
      }
      if (await api.workflowsTree(candidate) !== launcherWorkflows) {
        workflowChanged = true;
        continue;
      }
      journal.candidateSha = candidate;
      journal.ciRunId = proof.runId;
      journal.ciAttempt = proof.attempt;
      selected = proof;
      break;
    }
    if (selected === null) {
      journal.decision = chain.length === 1 ? "unchanged" : "deferred";
      journal.reason = chain.length === 1
        ? "launcher_current"
        : workflowChanged
        ? "workflow_change_needs_owner_advance"
        : "no_eligible_candidate";
    } else if (deps.flag !== "on") {
      journal.decision = "dry_run";
      journal.reason = "auto_follow_off";
    } else {
      const candidate = journal.candidateSha!;
      // Recheck the latest attempt, every head and active execution immediately
      // before the single expected-old-SHA, non-force mutation. No write retry.
      const proof = await recheckFollowCi(
        api,
        candidate,
        repositoryId,
        selected,
      );
      if (
        proof === null || proof.jobIds.join(",") !== selected.jobIds.join(",")
      ) throw new FollowError("ci_changed");
      if ((await activeSupervisorRuns(api)).length > 0) {
        throw new FollowError("supervisor_in_flight");
      }
      if (
        await api.ref(FOLLOW_DEVELOPMENT_REF) !==
          journal.observedDevelopmentSha ||
        await api.ref(FOLLOW_STATE_REF) !== state.head ||
        await api.ref(FOLLOW_LAUNCHER_REF) !== launcherSha
      ) throw new FollowError("heads_changed");
      writeSubmitted = true;
      await api.advance(repository.node_id, launcherSha, candidate);
      launcherSha = candidate;
      safeToDispatch = false;
      const observed = await api.ref(FOLLOW_LAUNCHER_REF);
      if (observed !== candidate) throw new FollowError("readback_mismatch");
      safeToDispatch = true;
      journal.decision = "advanced";
      journal.reason = "ci_green_descendant";
    }
  } catch (error) {
    journal.reason = error instanceof FollowError
      ? error.reason
      : "follow_unavailable";
    journal.decision = writeSubmitted && journal.reason !== "ref_conflict"
      ? "failed"
      : "deferred";
    if (writeSubmitted) {
      safeToDispatch = false;
      if (journal.reason === "ref_conflict") {
        try {
          safeToDispatch = await api.ref(FOLLOW_LAUNCHER_REF) === launcherSha;
        } catch {
          // Preserve the original conflict and refuse unverified dispatch.
        }
      }
    }
  } finally {
    api.dispose();
  }
  (deps.log ?? ((line) => console.log(JSON.stringify(line))))(journal);
  return {
    journal,
    launcherSha,
    safeToDispatch,
    exitCode: journal.decision === "failed" ? 1 : 0,
  };
}

/** The captured chain is a total ancestry order; its first green member is maximal. */
async function firstParentChain(
  api: HostedRuntimeFollowApi,
  development: string,
  launcher: string,
  maxDepth: number,
): Promise<string[]> {
  const chain = [development];
  const seen = new Set(chain);
  for (let depth = 0; chain[chain.length - 1] !== launcher; depth++) {
    if (depth >= maxDepth) throw new FollowError("first_parent_depth_limit");
    const current = chain[chain.length - 1];
    const commit = record(await api.get(`/commits/${current}`));
    if (commit.sha !== current || !Array.isArray(commit.parents)) {
      throw new FollowError("commit_identity_mismatch");
    }
    if (commit.parents.length === 0) throw new FollowError("launcher_diverged");
    const parent = sha(record(commit.parents[0]).sha);
    if (seen.has(parent)) throw new FollowError("commit_cycle");
    seen.add(parent);
    chain.push(parent);
  }
  return chain;
}
