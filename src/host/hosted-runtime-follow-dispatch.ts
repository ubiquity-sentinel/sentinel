import type { Clock } from "../contracts/ports.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../contracts/hosted-supervisor-types.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import {
  activeSupervisorRuns,
  FOLLOW_LAUNCHER_REF,
  FOLLOW_SUPERVISOR,
  FollowError,
  HostedRuntimeFollowApi,
  positive,
  record,
  sha,
} from "./hosted-runtime-follow-api.ts";
import { sameRepository } from "./hosted-runtime-follow-ci.ts";

export type FollowDispatchOutcome =
  | { valid: true; value: number; skipped?: boolean }
  | { valid: false; reason: string };

export interface FollowDispatchDeps {
  http: HttpTransportV1;
  token: string;
  clock: Clock;
  expectedSha: string;
  ready: boolean;
  log?: (line: Record<string, unknown>) => void;
  /** Injected in tests; production waits only for bounded API propagation. */
  pause?: () => Promise<void>;
  /** Uncancelled active runs positively observed by the same dispatcher pass. */
  observedActiveRunIds?: readonly number[];
}

/** One POST at most, even after lost acknowledgement or delayed visibility. */
export async function dispatchFollowedSupervisor(
  deps: FollowDispatchDeps,
  dispatch: () => Promise<FollowDispatchOutcome>,
): Promise<FollowDispatchOutcome> {
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const api = new HostedRuntimeFollowApi(deps.http, deps.token, 30_000);
  try {
    if (!deps.ready) throw new FollowError("follow_not_ready");
    const expected = sha(deps.expectedSha);
    const repositoryId = positive(record(await api.get("")).id);
    const observedActive = (deps.observedActiveRunIds?.length ?? 0) > 0;
    const listedActive = (await activeSupervisorRuns(api)).length > 0;
    if (observedActive || listedActive) {
      log({
        event: "follow_dispatch",
        decision: "skipped",
        reason: "supervisor_in_flight",
        launcherSha: expected,
      });
      return { valid: true, value: 0, skipped: true };
    }
    // Time only bounds an observation window; it never chooses a revision or
    // run. The unique new immutable ID relative to the baseline binds the POST.
    const query = {
      branch: "sentinel-supervisor",
      event: "workflow_dispatch",
      created: `>=${new Date(deps.clock.now() - 60_000).toISOString()}`,
    };
    const path = `/actions/workflows/${FOLLOW_SUPERVISOR}/runs`;
    const before = await api.list(path, "workflow_runs", query);
    const ids = new Set(before.map((run) => positive(run.id)));
    if (await api.ref(FOLLOW_LAUNCHER_REF) !== expected) {
      throw new FollowError("dispatch_ref_changed");
    }
    const acknowledged = await dispatch();
    // A failed/ambiguous acknowledgement is never retried. Reconcile its one
    // possible native effect against the same baseline instead.
    for (let attempt = 0; attempt < 6; attempt++) {
      const after = await api.list(path, "workflow_runs", query);
      const fresh = after.filter((run) => !ids.has(positive(run.id)));
      if (fresh.length > 1) {
        throw new FollowError("dispatch_identity_ambiguous");
      }
      if (fresh.length === 1) {
        const run = fresh[0];
        verifyRun(run, expected, repositoryId);
        const runId = positive(run.id);
        const runAttempt = positive(run.run_attempt);
        const native = record(
          await api.get(`/actions/runs/${runId}/attempts/${runAttempt}`),
        );
        verifyRun(native, expected, repositoryId);
        if (native.id !== runId || native.run_attempt !== runAttempt) {
          throw new FollowError("dispatch_identity_mismatch");
        }
        log({
          event: "follow_dispatch",
          decision: "verified",
          launcherSha: expected,
          runId,
          runAttempt,
          githubSha: native.head_sha,
        });
        return { valid: true, value: 204 };
      }
      if (attempt < 5) {
        await (deps.pause ??
          (() => new Promise<void>((resolve) => setTimeout(resolve, 2_000))))();
      }
    }
    throw new FollowError(
      acknowledged.valid ? "dispatch_not_observed" : "dispatch_unconfirmed",
    );
  } catch (error) {
    const reason = error instanceof FollowError
      ? error.reason
      : "dispatch_verification_unavailable";
    log({ event: "follow_dispatch", decision: "failed", reason });
    return { valid: false, reason };
  } finally {
    api.dispose();
  }
}

function verifyRun(
  run: Record<string, unknown>,
  expected: string,
  repositoryId: number,
): void {
  if (
    run.workflow_id !== HOSTED_SUPERVISOR_WORKFLOW_ID ||
    run.path !== HOSTED_SUPERVISOR_WORKFLOW_PATH ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "sentinel-supervisor" ||
    run.head_sha !== expected ||
    !sameRepository(run.repository, repositoryId) ||
    !sameRepository(run.head_repository, repositoryId)
  ) throw new FollowError("dispatch_sha_mismatch");
}
