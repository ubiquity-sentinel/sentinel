import type { HostedReleaseRecordV1 } from "./hosted-supervisor.ts";
import type { GitSha } from "./brands.ts";
import type { LocalReleaseReceiptV1 } from "./local-release.ts";
import type { ReleaseRequestV1 } from "./release.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "./state-snapshots.ts";
import type { PortResultV1 } from "./ports.ts";

// ---------------------------------------------------------------------------
// StateStore: separate repair/release snapshot branches with strict
// expected-head compare-and-swap. Only repair writes work/budget/release
// requests; only release writes release records. The read-only view is
// separate from the writer capabilities so a release consumer never receives
// repair write capability (or vice versa); StateStore combines them for tests.
// ---------------------------------------------------------------------------

export type StateReadResultV1<T> =
  | { status: "found"; snapshot: T; head: GitSha; ref: string | null }
  | { status: "absent"; currentHead: GitSha | null; ref: string | null };

export type StateWriteResultV1 =
  | { status: "applied"; head: GitSha }
  | { status: "conflict"; currentHead: GitSha | null }
  | { status: "ambiguous"; currentHead: GitSha | null };

export interface StateReadView {
  readRepair(): Promise<PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>>;
  /** Read one strict ancestor of the freshly verified fixed repair ref. */
  readRepairAt?(input: {
    commit: GitSha;
    expectedHead: GitSha;
  }): Promise<PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>>;
  /** Pinned read-only history; callers must revalidate live repair state before using proofs. */
  openRepairHistory?(input: {
    expectedHead: GitSha;
  }): Promise<PortResultV1<RepairHistoryViewV1>>;
  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  >;
  /** Read one strict ancestor of the freshly verified fixed release ref. */
  readReleaseAt?(input: {
    commit: GitSha;
    expectedHead: GitSha;
  }): Promise<PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>>;
  /**
   * Optional bounded history capability: one complete fetch of the fixed
   * release ref, which must equal `expectedHead`, then local ancestor reads
   * (see ReleaseHistoryViewV1). It never re-proves that the head is still
   * current; a caller that acts on what it read re-verifies custody first.
   */
  openReleaseHistory?(input: {
    expectedHead: GitSha;
  }): Promise<PortResultV1<ReleaseHistoryViewV1>>;
  /**
   * Optional local-activation capability, owned only by hosts that own the
   * private local release scope. It reads the exact strict private receipt for
   * one local Sentinel release request: a missing receipt is an explicit null,
   * while a corrupt, unreadable or identity-mismatched receipt is unavailable
   * (never a null and never a hosted-release fallback). Hosts without a local
   * scope leave the method absent, and no repair process ever writes these
   * receipts.
   */
  readLocalRelease?(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<LocalReleaseReceiptV1 | null>>;
  /**
   * Optional hosted-supervisor capability, owned only by the trusted hosted
   * host for the explicit self scope-0 repository. It reads the protected
   * supervisor's PERSISTED receipt for one self production release request: a
   * missing record is an explicit null, while a corrupt, unreadable, malformed
   * or differently-bound receipt is unavailable (never null, and never a raw
   * workflow-green run or local fallback). Hosts without the capability leave
   * the method absent.
   */
  readHostedRelease?(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<HostedReleaseRecordV1 | null>>;
}

/**
 * One opened local view of the release history under a verified head. Each
 * read proves the commit is an ancestor of that head in the fetched object
 * store and decodes it with the same validated tree reader as readReleaseAt.
 */
export interface RepairHistoryViewV1 {
  readAt(
    commit: GitSha,
  ): Promise<PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>>;
  /** Settles active reads and removes only the owned directory; later reads refuse. */
  close(): Promise<void>;
}

export interface ReleaseHistoryViewV1 {
  readAt(
    commit: GitSha,
  ): Promise<PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>>;
  /** Removes the private workdir; later reads are unavailable. */
  close(): Promise<void>;
}

export interface RepairStateWriter {
  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>>;
}

export interface ReleaseStateWriter {
  writeRelease(
    next: ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>>;
}

export interface StateStore
  extends StateReadView, RepairStateWriter, ReleaseStateWriter {}
