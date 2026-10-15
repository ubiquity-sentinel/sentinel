import type { GitSha } from "../contracts/brands.ts";
import type {
  PortResultV1,
  StateReadResultV1,
  StateReadView,
} from "../contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { tryParse } from "../contracts/validation.ts";
import { createReleaseStateStore, DenoGitRunner } from "../state/mod.ts";
import { ensurePrivateDir, githubGitAuthEnv, joinPath } from "./local.ts";
import { OWNER_STARTUP_RECOVERY_CANDIDATE } from "./owner-startup-recovery.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_DEVELOPMENT_BRANCH,
  OWNER_DEVELOPMENT_INSTALL_REMOTE_URL,
  OWNER_DEVELOPMENT_INSTALL_REPOSITORY,
} from "./owner-install-pins.ts";
import type {
  OwnerDevelopmentInstallStateReadV1,
} from "./owner-install-types.ts";
import {
  compareConfirmsAncestor,
  ownerDevelopmentInstallApi,
  requireStatus,
  testLocalCheckSucceeded,
} from "./owner-install-api.ts";

export async function createOwnerDevelopmentInstallState(
  appToken: string,
): Promise<StateReadView> {
  const sentinelDir = joinPath(Deno.cwd(), ".sentinel");
  const scratch = joinPath(sentinelDir, "state-scratch");
  const gitHome = joinPath(sentinelDir, "state-git-home");
  await ensurePrivateDir(scratch);
  await ensurePrivateDir(gitHome);
  // Read-only capability only: this operation never calls a store writer and
  // never changes the store's schema or transition policy.
  return createReleaseStateStore({
    scratchDir: scratch,
    remoteUrl: OWNER_DEVELOPMENT_INSTALL_REMOTE_URL,
    runner: new DenoGitRunner(gitHome, githubGitAuthEnv(appToken)),
  });
}

export async function readOwnerDevelopmentInstallState(
  state: StateReadView,
): Promise<OwnerDevelopmentInstallStateReadV1> {
  let read: PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>;
  try {
    read = await state.readRelease();
  } catch {
    return { status: "unavailable" };
  }
  if (!read.ok) return { status: "unavailable" };
  if (read.value.status === "absent") return { status: "absent" };
  const parsed = tryParse(parseReleaseStateSnapshotV1, read.value.snapshot);
  if (!parsed.ok) return { status: "unavailable" };
  return { status: "found", snapshot: parsed.value, head: read.value.head };
}

/**
 * Read-only verification of one installed revision: the exact SHA must be an
 * ancestor of the current development ref, or of the exact verified startup
 * controller for the single pinned recovery, and must carry a completed
 * successful `test-local` check. Both reads use the repository token only;
 * a negative or unavailable answer is a normal waiting outcome.
 */
export async function verifyOwnerDevelopmentInstallRevision(
  token: string,
  revision: GitSha,
  startupLauncher?: GitSha,
): Promise<{ verified: boolean; detail: string }> {
  if (
    startupLauncher !== undefined &&
    revision !== OWNER_STARTUP_RECOVERY_CANDIDATE
  ) {
    return {
      verified: false,
      detail: "startup candidate is not the exact approved pin",
    };
  }
  const compare = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/compare/${revision}...${
      startupLauncher ?? OWNER_DEVELOPMENT_INSTALL_DEVELOPMENT_BRANCH
    }?per_page=1&page=2`,
  );
  if (!compare.ok) {
    return { verified: false, detail: "revision ancestry is unavailable" };
  }
  const compared = requireStatus(compare.value, 200);
  if (!compared.ok) {
    return { verified: false, detail: "revision ancestry is unavailable" };
  }
  // GitHub compare has no head_commit field. The exact immutable request URL
  // above binds the verified startup controller; base/merge-base and counters
  // must still prove that the pinned candidate is its ancestor.
  if (!compareConfirmsAncestor(compared.value, revision)) {
    return {
      verified: false,
      detail: startupLauncher === undefined
        ? "revision is not an ancestor of development"
        : "revision is not an ancestor of the startup controller",
    };
  }
  const checks = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/commits/${revision}/check-runs?per_page=100`,
  );
  if (!checks.ok) {
    return { verified: false, detail: "revision checks are unavailable" };
  }
  const listed = requireStatus(checks.value, 200);
  if (!listed.ok) {
    return { verified: false, detail: "revision checks are unavailable" };
  }
  if (!testLocalCheckSucceeded(listed.value, revision)) {
    return {
      verified: false,
      detail: "revision has no successful completed test-local check",
    };
  }
  return { verified: true, detail: "revision verified" };
}
