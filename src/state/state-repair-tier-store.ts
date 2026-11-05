/**
 * Store-side operations of the hot/cold repair tiers, run inside one private
 * GitStateStore operation directory: the explicit full-ledger read and the
 * trusted expected-head tier transition (formed by state-repair-tier.ts,
 * pushed without force and reconciled against the authoritative ref).
 */

import type { GitSha } from "../contracts/brands.ts";
import type {
  PortErrorV1,
  PortResultV1,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { LoadedState, OpContext } from "./state-git.ts";
import {
  buildRepairTierCommit,
  readRepairTieredView,
} from "./state-repair-tier.ts";
import type {
  RepairTieredSnapshotV1,
  RepairTierIoV1,
  RepairTierResultV1,
} from "./state-repair-tier.ts";
import type { RepairTierPolicyV1 } from "./state-repair-tier-plan.ts";

/** Result of the explicit full-ledger (hot + cold) repair read. */
export type RepairTieredReadV1 =
  | { status: "absent"; currentHead: null; ref: string }
  | {
    status: "found";
    head: GitSha;
    ref: string;
    view: RepairTieredSnapshotV1;
  };

/** Trusted repair-writer tier capability (hot/cold transitions). */
export interface RepairTierStore {
  /**
   * Explicit full-ledger view (hot + cold) for historical and compatible
   * readers: accounting, audits. The hot step loop, planner and maintenance
   * walk use `readRepair`, which never lists or parses the cold tier.
   */
  readRepairTiered(): Promise<PortResultV1<RepairTieredReadV1>>;
  /**
   * Trusted hot/cold tier transition at the exact expected head: promotes
   * every reopened cold family and demotes eligible families within the
   * policy budget, by byte-identical tree moves and a non-force push.
   */
  tierRepair(
    input: RepairTierPolicyV1 & { expectedHead: GitSha },
  ): Promise<PortResultV1<RepairTierResultV1>>;
}

export interface PushedCandidateV1 {
  pushed: boolean;
  head: GitSha;
  pushFailureKind: PortErrorV1["kind"] | null;
}

/** GitStateStore internals one tier operation may use. */
export interface RepairTierStoreHooksV1 {
  ref: string;
  io: RepairTierIoV1;
  loadRepair(op: OpContext): Promise<PortResultV1<LoadedState>>;
  push(op: OpContext, commit: GitSha): Promise<PushedCandidateV1>;
  reconcile(
    op: OpContext,
    candidate: PushedCandidateV1,
    priorHead: GitSha,
  ): Promise<PortResultV1<StateWriteResultV1>>;
}

export async function readRepairTieredOp(
  hooks: RepairTierStoreHooksV1,
  op: OpContext,
): Promise<PortResultV1<RepairTieredReadV1>> {
  const loaded = await hooks.loadRepair(op);
  if (!loaded.ok) return loaded;
  if (loaded.value.status === "absent") {
    return portOk({ status: "absent", currentHead: null, ref: hooks.ref });
  }
  const view = await readRepairTieredView(
    hooks.io,
    op,
    loaded.value.head,
    loaded.value.snapshot as RepairStateSnapshotV1,
  );
  if (!view.ok) return view;
  return portOk({
    status: "found",
    head: loaded.value.head,
    ref: hooks.ref,
    view: view.value,
  });
}

export async function tierRepairOp(
  hooks: RepairTierStoreHooksV1,
  op: OpContext,
  input: RepairTierPolicyV1 & { expectedHead: GitSha },
): Promise<PortResultV1<RepairTierResultV1>> {
  const loaded = await hooks.loadRepair(op);
  if (!loaded.ok) return loaded;
  if (loaded.value.status !== "found") {
    return portOk({ status: "conflict", currentHead: null });
  }
  const head = loaded.value.head;
  if (head !== input.expectedHead) {
    return portOk({ status: "conflict", currentHead: head });
  }
  const built = await buildRepairTierCommit(
    hooks.io,
    op,
    head,
    loaded.value.snapshot as RepairStateSnapshotV1,
    input,
  );
  if (!built.ok) return built;
  if (built.value.status === "unchanged") {
    return portOk({
      status: "unchanged",
      head,
      deferred: built.value.deferred,
    });
  }
  const {
    commit,
    demoted,
    promoted,
    deferred,
    releaseRequestsMovedToCold,
    promotedOpenReleaseRequestIds,
  } = built.value;
  let pushed: PushedCandidateV1;
  try {
    pushed = await hooks.push(op, commit);
  } catch {
    // The ref, not the push response, decides the outcome below.
    pushed = { pushed: false, head: commit, pushFailureKind: null };
  }
  const reconciled = await hooks.reconcile(op, pushed, head);
  if (!reconciled.ok) return reconciled;
  if (reconciled.value.status !== "applied") return portOk(reconciled.value);
  return portOk({
    status: "applied",
    head: reconciled.value.head,
    demoted,
    promoted,
    deferred,
    releaseRequestsMovedToCold,
    promotedOpenReleaseRequestIds,
  });
}
