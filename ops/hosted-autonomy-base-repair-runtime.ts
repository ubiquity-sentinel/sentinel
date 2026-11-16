/**
 * The base-repair pass's installed-runtime gate (2026-11-16; reworked after
 * the third review of the ai.ubq.fi enablement the same day).
 *
 * Filing runs in the launcher; the cap on a filed task's charged CI fixes
 * (`BASE_REPAIR_CI_FIX_CAP`, `src/repair/base-repair.ts`) runs in the
 * INSTALLED runtime. The two differ during an install, after a rollback
 * (whose target is the runtime installed before) and while the launcher and
 * the runtime pointer stand at different commits. The launcher therefore
 * files only while:
 *
 * - the release state names the installed runtime (the hosted runtime
 *   pointer every maintenance phase reads, never the launcher's checkout);
 * - no installation is in flight, since its bootstrap could still roll the
 *   pointer back to the runtime before it; and
 * - the installed revision's OWN source carries the cap: every file of
 *   `BASE_REPAIR_CAP_SOURCES`, read from the Sentinel repository at exactly
 *   that commit (`readFileAt`, blob-checked), shows what
 *   `runtimeSourceCarriesCap` requires.
 *
 * The earlier proof, that the installed revision descends from the commit
 * that landed the cap, did not show the cap was still there: a later revert
 * of that commit stays its descendant, and the third review filed on such a
 * runtime. The installed source answers that whatever history led to it, so
 * no commit id is pinned here. The facts are text over that source; a test
 * pins that they hold on this checkout, so a change that moves the cap fails
 * CI instead of silently stopping filing. Anything unproven files nothing,
 * with a fixed reason.
 */
import { HOSTED_RUNTIME_ID } from "../src/contracts/hosted-supervisor.ts";
import { installationTerminal } from "../src/contracts/hosted-supervisor-installation.ts";
import { BASE_REPAIR_CI_FIX_CAP } from "../src/repair/base-repair.ts";
import { HOSTED_AUTONOMY_SELF_SCOPE } from "./hosted-autonomy-policy.ts";
import { readReleaseSafely } from "./hosted-autonomy-state.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";

/**
 * The installed source files the gate reads: the cap's declaration and the
 * CI-fix admission that enforces it (`prepareImplementationStart`).
 */
export const BASE_REPAIR_CAP_SOURCES = Object.freeze(
  {
    cap: "src/repair/base-repair.ts",
    admission: "src/repair/loop-implementation.ts",
  } as const,
);

export type BaseRepairCapSourcesV1 = Record<
  keyof typeof BASE_REPAIR_CAP_SOURCES,
  string
>;

/** The cap's one top-level declaration: a positive whole number. */
const CAP_DECLARATION =
  /^export const BASE_REPAIR_CI_FIX_CAP = ([1-9][0-9]{0,2});$/gm;

/** The count of an issue's fixes across its parts (2026-11-16). */
const CAP_PER_ISSUE = /^export function baseRepairCiFixesSpent\(/m;

/**
 * The admission's call of the capped check, before any charge, over the
 * run's records (so a split task's parts share one cap).
 */
const CAP_ADMISSION =
  /\bawait baseRepairCiFixCapped\(\s*deps,\s*record,\s*context\.snapshot\.work,?\s*\)/;

/**
 * Whether installed source text carries the cap: `cap` declares
 * `BASE_REPAIR_CI_FIX_CAP` exactly once, at a value from 1 to this
 * launcher's own (a larger one would break the bound the launcher states),
 * and counts an issue's fixes across its parts, and `admission` calls the
 * capped check over the run's records. A revert of the cap, a runtime from
 * before it, the first cap (2026-11-16, each part its own cap) and a runtime
 * whose cap is larger than this launcher's all fail.
 */
export function runtimeSourceCarriesCap(
  sources: BaseRepairCapSourcesV1,
): boolean {
  const declared = [...sources.cap.matchAll(CAP_DECLARATION)];
  if (declared.length !== 1) return false;
  const cap = Number(declared[0][1]);
  return cap >= 1 && cap <= BASE_REPAIR_CI_FIX_CAP &&
    CAP_PER_ISSUE.test(sources.cap) && CAP_ADMISSION.test(sources.admission);
}

/**
 * Why the installed runtime holds base-repair filing, as the pass's action
 * suffix, or null when it carries the cap: `runtime_unreadable` when the
 * release state, its runtime pointer or one of the installed source files
 * cannot be read, `runtime_installing` while an installation is in flight,
 * `runtime_uncapped` when the installed source, read whole, does not carry
 * the cap (`runtimeSourceCarriesCap`).
 */
export async function baseRepairRuntimeHold(
  deps: Pick<HostedAutonomyDepsV1, "state" | "githubFor">,
): Promise<string | null> {
  const read = await readReleaseSafely(deps.state);
  if (read === null || !read.ok || read.value.status !== "found") {
    return "runtime_unreadable";
  }
  const release = read.value.snapshot;
  const runtime = release.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  if (runtime === undefined) return "runtime_unreadable";
  if (
    (release.hostedInstallations ?? []).some((row) =>
      !installationTerminal(row)
    )
  ) {
    return "runtime_installing";
  }
  const sources: Partial<BaseRepairCapSourcesV1> = {};
  try {
    const self = deps.githubFor(HOSTED_AUTONOMY_SELF_SCOPE);
    if (self?.readFileAt === undefined) return "runtime_unreadable";
    for (
      const [key, path] of Object.entries(BASE_REPAIR_CAP_SOURCES) as [
        keyof BaseRepairCapSourcesV1,
        string,
      ][]
    ) {
      const text = await self.readFileAt(path, runtime.activeRevision);
      if (typeof text !== "string") return "runtime_unreadable";
      sources[key] = text;
    }
  } catch {
    return "runtime_unreadable";
  }
  return runtimeSourceCarriesCap(sources as BaseRepairCapSourcesV1)
    ? null
    : "runtime_uncapped";
}
