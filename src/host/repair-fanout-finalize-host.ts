/**
 * Finalize's production composition of the repair fan-out apply (issue
 * #328). It binds the saved execution of this exact run (its runtime revision,
 * generation and the shared run deadline: the execution's creation plus the
 * fixed run ceiling), the native read token for the Actions reads and the
 * trusted repair state writer, then authenticates and applies the deltas.
 * Advisory to finalize: it never throws and never changes the finalize
 * outcome; it prints one closed status line (the fan-out summary line with
 * the per-repository wall times and the apply time is printed by the apply).
 */
import type { GitSha } from "../contracts/brands.ts";
import type { Clock, StateReadView } from "../contracts/ports.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import { REPAIR_RUN_CEILING_MS } from "../repair/loop-bounds.ts";
import type { RepairCycleDepsV1 } from "../repair/loop-types.ts";
import { createRepairStateStore, DenoGitRunner } from "../state/mod.ts";
import { REMOTE_URL } from "./actions-supervisor-bootstrap.ts";
import { ensurePrivateDir, githubGitAuthEnv, joinPath } from "./local.ts";
import { createActionsMatrixArtifactHttpTransport } from "./matrix-artifacts.ts";
import { runRepairFanoutFinalize } from "./repair-fanout-finalize.ts";

/** The finalize step's environment key for the native plan digest. */
export const REPAIR_PLAN_DIGEST_ENV = "SENTINEL_REPAIR_PLAN_DIGEST";
export const REPAIR_FANOUT_FINALIZE_KIND = "sentinel_repair_fanout_finalize";

/** The digest to apply, or null when the run planned no repository cell. */
export function repairPlanDigestOf(value: string | undefined): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

export async function finalizeRepairFanout(input: {
  release: Pick<StateReadView, "readRelease">;
  repair: () => Promise<RepairCycleDepsV1["state"]>;
  token: string;
  http: HttpTransportV1;
  clock: Clock;
  run: { runId: number; runAttempt: number; launcherSha: GitSha };
  planDigest: string;
  log?: (line: string) => void;
}): Promise<string> {
  const log = input.log ?? ((line: string) => console.log(line));
  let status = "unavailable";
  try {
    const release = await input.release.readRelease();
    const runtime = release.ok && release.value.status === "found"
      ? release.value.snapshot.hostedRuntimes[0]
      : undefined;
    const execution = runtime?.execution ?? null;
    if (
      execution !== null &&
      execution.id === `${input.run.runId}:${input.run.runAttempt}:repair` &&
      execution.runId === input.run.runId &&
      execution.runAttempt === input.run.runAttempt &&
      execution.launcherSha === input.run.launcherSha
    ) {
      const result = await runRepairFanoutFinalize({
        token: input.token,
        http: input.http,
        clock: input.clock,
        state: await input.repair(),
        run: input.run,
        runtime: {
          revision: execution.revision,
          generation: execution.generation,
        },
        planDigest: input.planDigest,
        deadline: execution.createdAt + REPAIR_RUN_CEILING_MS,
      });
      if (result !== null) status = result.status;
    }
  } catch {
    status = "unavailable";
  }
  try {
    log(JSON.stringify({
      kind: REPAIR_FANOUT_FINALIZE_KIND,
      runId: input.run.runId,
      attempt: input.run.runAttempt,
      status,
    }));
  } catch { /* advisory */ }
  return status;
}

/**
 * The production hook: present only in finalize when the native outputs
 * carried a fan-out plan digest. The repair state store uses the same self
 * installation credentials and remote as the release state, in its own
 * private scratch.
 */
export function repairFanoutHook(
  job: string,
  env: Readonly<Record<string, string | undefined>>,
  host: {
    sentinelDir: string;
    gitHome: string;
    selfToken: string;
    nativeToken: string;
    clock: Clock;
    state: Pick<StateReadView, "readRelease">;
    identity: { runId: number; runAttempt: number; launcherSha: GitSha };
  },
): (() => Promise<unknown>) | undefined {
  const planDigest = repairPlanDigestOf(env[REPAIR_PLAN_DIGEST_ENV]);
  if (job !== "finalize" || planDigest === null) return undefined;
  return () =>
    finalizeRepairFanout({
      release: host.state,
      repair: async () => {
        const scratchDir = joinPath(host.sentinelDir, "repair-state-scratch");
        await ensurePrivateDir(scratchDir);
        return createRepairStateStore({
          scratchDir,
          remoteUrl: REMOTE_URL,
          runner: new DenoGitRunner(
            host.gitHome,
            githubGitAuthEnv(host.selfToken),
          ),
        });
      },
      token: host.nativeToken,
      http: createActionsMatrixArtifactHttpTransport(),
      clock: host.clock,
      run: {
        runId: host.identity.runId,
        runAttempt: host.identity.runAttempt,
        launcherSha: host.identity.launcherSha,
      },
      planDigest,
    });
}
