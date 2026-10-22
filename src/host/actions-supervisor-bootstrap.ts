/** Hosted actions-supervisor-bootstrap responsibility. */
import type { ReleaseStateWriter, StateReadView } from "../contracts/ports.ts";
import { HOSTED_CONTROLLER_REMOTE } from "../contracts/hosted-controller-deployment.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { createReleaseStateStore, DenoGitRunner } from "../state/mod.ts";
import { githubGitAuthEnv, joinPath } from "./local.ts";
import { isToken } from "./actions-supervisor-host.ts";

export const REMOTE_URL = HOSTED_CONTROLLER_REMOTE;

export const SUPERVISOR_TOKEN_ENV = "SENTINEL_SUPERVISOR_TOKEN";

export const STATIC_TOKEN = "hosted supervisor credentials are unavailable";

export const STATIC_STATE = "hosted supervisor release state is unavailable";

export const STATIC_SEED =
  "hosted supervisor release state could not be seeded";

/**
 * The one fixed GitHub App reviewer identity that may authorize an
 * issue-backed release at the persisted-receipt boundary: sentinel App
 * 4682172, bot user 319834869, whose review login is `ubiquity-sentinel[bot]`.
 * The predicate pins this exact reviewer string, so a self-consistent receipt
 * naming any other reviewer is a different reviewer and never authorizes.
 * Legacy receipts still parse; they refuse as new authorization.
 */
export const HOSTED_SUPERVISOR_REVIEWER = "ubiquity-sentinel[bot]";

export interface HostedSupervisorBootstrapResultV1 {
  status: "seeded" | "already_present";
  head: string;
  sequence: number;
}

/**
 * Seed the release-state branch exactly once, then reread its authoritative
 * commit. A concurrent or lost write response is reconciled by the same
 * reread; no force push or replacement state is attempted.
 */
export async function ensureHostedReleaseStateSeed(
  token: string,
  scratchDir: string,
  now = Date.now(),
): Promise<HostedSupervisorBootstrapResultV1> {
  if (!isToken(token)) throw new Error(STATIC_TOKEN);
  if (typeof scratchDir !== "string" || scratchDir.length === 0) {
    throw new Error(STATIC_STATE);
  }
  const state = createReleaseStateStore({
    scratchDir,
    remoteUrl: REMOTE_URL,
    runner: new DenoGitRunner(
      joinPath(scratchDir, "git-home"),
      githubGitAuthEnv(token),
    ),
  });
  return await ensureHostedReleaseState(state, now);
}

/**
 * Seed the release-state branch exactly once through an already-built
 * release-role store, then reread its authoritative commit. A concurrent or
 * lost write response is reconciled by the same reread; a found snapshot is
 * never replaced and no force push is attempted.
 */
export async function ensureHostedReleaseState(
  state: StateReadView & ReleaseStateWriter,
  now = Date.now(),
): Promise<HostedSupervisorBootstrapResultV1> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error(STATIC_STATE);
  const current = await state.readRelease();
  if (!current.ok) throw new Error(`${STATIC_STATE} (${current.error.kind})`);
  if (current.value.status === "found") {
    return {
      status: "already_present",
      head: current.value.head,
      sequence: current.value.snapshot.sequence,
    };
  }

  const seed = emptyReleaseState(now);
  const written = await state.writeRelease(seed, null);
  if (!written.ok) throw new Error(`${STATIC_SEED} (${written.error.kind})`);
  if (written.value.status === "applied") {
    const afterWrite = await state.readRelease();
    if (!afterWrite.ok || afterWrite.value.status !== "found") {
      throw new Error(STATIC_SEED);
    }
    return {
      status: "seeded",
      head: afterWrite.value.head,
      sequence: afterWrite.value.snapshot.sequence,
    };
  }

  // A competing supervisor may have created the absent ref, or the response
  // may have been lost after the App write. Only an authoritative reread can
  // settle that ambiguity; a conflict never causes a force overwrite.
  const reconciled = await state.readRelease();
  if (!reconciled.ok || reconciled.value.status !== "found") {
    throw new Error(STATIC_SEED);
  }
  return {
    status: "already_present",
    head: reconciled.value.head,
    sequence: reconciled.value.snapshot.sequence,
  };
}

function emptyReleaseState(now: number): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: now,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  });
}
