/** Source-only owner intent authentication; no state writer or execution authority. */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { HostedOwnerSupersessionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { parseHostedCustodyCapability } from "./hosted-custody-capability.ts";
import { parseHostedRuntimeRollout } from "./hosted-runtime-rollout.ts";
import {
  type ReadInput,
  sourceApproved,
  sourceData,
} from "./owner-install-future-recovery.ts";
import { ownerStartupSourceHead } from "./owner-install-startup-evidence.ts";
import {
  compareConfirmsAncestor,
  ownerDevelopmentInstallApi,
} from "./owner-install-api.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { readHostedAppSourceManifest } from "./hosted-app-principal-source.ts";
import { parseHostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { QueueRuntimeCapability } from "./queue-runtime-capability.ts";
import type { ExistingPrRuntimeCapability } from "./existing-pr-runtime-capability.ts";
import type { HostedRuntimeRollout } from "./hosted-runtime-rollout.ts";

export async function ownerSupersessionSourceData(input: {
  launcherSha: GitSha;
  queue: QueueRuntimeCapability;
  custody: ExistingPrRuntimeCapability;
  rollout: HostedRuntimeRollout;
}): Promise<boolean> {
  if (await ownerStartupSourceHead() !== input.launcherSha) return false;
  const pins = parseHostedRuntimeRollout(
    JSON.parse(await sourceData("src/host/hosted-runtime-rollout.json")),
  );
  const capability = parseHostedCustodyCapability(
    JSON.parse(await sourceData("src/host/hosted-custody-capability.json")),
  );
  return canonicalStringify(pins) === canonicalStringify(input.rollout) &&
    canonicalStringify({
        queue: capability.queue,
        custody: capability.existingPr,
      }) ===
      canonicalStringify({ queue: input.queue, custody: input.custody });
}

/** The accepted code commit precedes the containing data commit; their included bytes must equal. */
export async function ownerSupersessionSourceApproved(
  input: ReadInput,
  row: HostedOwnerSupersessionIntentV1,
  now: number,
): Promise<boolean> {
  if (!await sourceApproved(input, row, now)) return false;
  const root = await Deno.realPath(Deno.cwd());
  const manifest = await readHostedAppSourceManifest({
    launcherDir: root,
    runtimeDir: root,
    identity: { ...input.run, job: "repair" },
    execution: parseHostedExecutionIntentV1({
      id: `${input.run.runId}:${input.run.runAttempt}:repair`,
      ...input.run,
      purpose: "bootstrap",
      releaseId: null,
      revision: row.toRevision,
      generation: row.toGeneration,
      createdAt: now,
    }),
    process: new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
  }, root);
  if (manifest.digest !== row.controllerCodeSha256) return false;
  const diff = await new Deno.Command("git", {
    args: [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "diff",
      "--name-only",
      "--no-ext-diff",
      row.controllerSourceRevision,
      "HEAD",
      "--",
    ],
    cwd: root,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdout: "piped",
    stderr: "null",
    signal: AbortSignal.timeout(10_000),
  }).output();
  if (!diff.success || diff.stdout.length > 512 * 1024) return false;
  const data = new Set([
    "src/host/hosted-runtime-rollout.json",
    "src/host/hosted-custody-capability.json",
    "src/host/hosted-app-source-profiles.json",
  ]);
  const changed = new TextDecoder("utf-8", { fatal: true }).decode(diff.stdout)
    .trim().split("\n").filter(Boolean);
  if (
    changed.some((path) =>
      !data.has(path) &&
      (path.startsWith("src/") || path.startsWith("ops/") ||
        path.startsWith(".github/") ||
        ["sentinel.targets.json", "deno.json", "deno.lock", "import_map.json"]
          .includes(path))
    )
  ) return false;
  for (
    const ancestor of [...row.requiredAncestors, row.controllerSourceRevision]
  ) {
    const target = ancestor === row.controllerSourceRevision
      ? input.run.launcherSha
      : row.toRevision;
    const compared = await ownerDevelopmentInstallApi(
      input.token,
      "GET",
      `/repos/ubiquity/sentinel/compare/${ancestor}...${target}?per_page=1&page=2`,
    );
    if (
      !compared.ok || compared.value.status !== 200 ||
      !compareConfirmsAncestor(compared.value.value, ancestor)
    ) return false;
  }
  return true;
}
