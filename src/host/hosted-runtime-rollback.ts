/** Launcher-owned state reader around the unchanged, exact rollback host module. */
import { createRepairStateStore, DenoGitRunner } from "../state/mod.ts";
import { githubGitAuthEnv, joinPath } from "./local.ts";
import {
  parseHostedEnvironment,
  readHostedIdentityEnv,
  readHostedRuntimeCustody,
  REMOTE_URL,
} from "./hosted-runtime-identity.ts";
import { readNativeMatrixStdin, runtimeJob } from "./hosted-runtime-matrix.ts";
import type { ActionsTargetCyclesInputV1 } from "./actions.ts";
import type { RepairStateWriter, StateReadView } from "../contracts/ports.ts";
import type { GitRunnerV1 } from "../state/mod.ts";
import {
  createHostedRollbackState,
  needsHostedLegacyStateView,
} from "./hosted-runtime-rollback-state.ts";

export const HOSTED_RUNTIME_ROLLBACK_ENTRYPOINT =
  "src/host/hosted-runtime-rollback.ts";

export async function runHostedRollbackChild(input: {
  env?: Readonly<Record<string, string | undefined>>;
  root?: string;
  state?: StateReadView & RepairStateWriter;
  runner?: GitRunnerV1;
  stdin?: AsyncIterable<Uint8Array>;
} = {}): Promise<void> {
  const env = input.env ?? readHostedIdentityEnv();
  const job = runtimeJob(env.GITHUB_JOB);
  const identity = parseHostedEnvironment(env, job);
  const root = input.root ?? Deno.cwd();
  const token = input.env === undefined
    ? Deno.env.get("GITHUB_TOKEN")
    : input.env.GITHUB_TOKEN;
  if (!token) throw new Error("rollback state credential is unavailable");
  const scratch = joinPath(root, ".sentinel-actions-state", "state-scratch");
  const store = input.state ?? createRepairStateStore({
    scratchDir: scratch,
    remoteUrl: REMOTE_URL,
    runner: new DenoGitRunner(
      joinPath(scratch, "state-git-home"),
      githubGitAuthEnv(token),
    ),
  });
  const head = await (input.runner ??
    new DenoGitRunner(joinPath(scratch, "identity-git-home")))
    .runGit(["rev-parse", "HEAD"], { cwd: root });
  if (!head.ok || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) {
    throw new Error("rollback source identity is unavailable");
  }
  const { release, execution } = await readHostedRuntimeCustody({
    state: store,
    identity,
    controllerSha: head.stdout.trim() as typeof identity.launcherSha,
  });
  const admission = release.hostedRuntimes[0]?.ordinaryAdmission;
  if (
    !needsHostedLegacyStateView(release, execution) ||
    execution.purpose === "ordinary" && admission?.mode === "degraded" &&
      admission.executionId === execution.id &&
      admission.revision === execution.revision &&
      admission.generation === execution.generation
  ) throw new Error("rollback state projection is not authorized");
  const state = createHostedRollbackState(store);
  if (job === "repair") {
    // The original entrypoint's bounded stdin protocol, including review custody.
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const part of input.stdin ?? Deno.stdin.readable) {
      size += part.byteLength;
      if (size > 4096) throw new Error("trusted publisher input exceeds bound");
      parts.push(part);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const runtime = await import(
      new URL(`file://${root}/src/host/actions.ts`).href
    );
    const matrix = await import(
      new URL(`file://${root}/src/host/matrix-actions.ts`).href
    );
    await runtime.runActionsRepairHost({
      state,
      runTargetCycles: (input: ActionsTargetCyclesInputV1) =>
        matrix.runActionsMatrixAggregateCycles(
          input,
          undefined,
          input.host?.matrixCarrier,
        ),
      ...(size === 0 ? {} : {
        trustedStdin: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      }),
    });
  } else {
    const stdin = await readNativeMatrixStdin();
    const runtime = await import(
      new URL(`file://${root}/src/host/matrix-actions.ts`).href
    );
    await runtime.runActionsMatrixHost({
      state,
      ...(stdin === undefined ? {} : { carrier: JSON.parse(stdin) }),
    });
  }
}

if (import.meta.main) await runHostedRollbackChild();
