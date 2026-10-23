/**
 * One bounded read-only view of the fixed release history: exactly one
 * complete fetch of the freshly verified ref, which must equal the expected
 * head. Every later read applies readReleaseAt's own commit checks — identity
 * format, ancestry of that head and the validated tree decoder — against the
 * fetched object store without another remote round trip. The view never
 * re-proves that the head is still current, so a caller that acts on a read
 * re-verifies custody first. close() removes the private workdir.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1, ReleaseHistoryViewV1 } from "../contracts/ports.ts";
import type { RepairHistoryViewV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { GitRunResultV1, LoadedState, OpContext } from "./state-git.ts";
import { StateTreeMemo } from "./state-repair-history-cache.ts";

const REMOVE_RETRY_DELAYS_MS = [0, 10, 25, 50, 100] as const;

/**
 * Git may still be releasing its scratch tree when the final read settles.
 * A recursive unlink can then observe ENOTEMPTY mid-removal; retry the same
 * owned directory without weakening close, and treat an already-absent
 * directory as success.
 */
async function removeScratchDirectory(path: string): Promise<void> {
  let last: unknown;
  for (const delay of REMOVE_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await Deno.remove(path, { recursive: true });
      return;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      last = error;
    }
  }
  throw last;
}

/** The store's own bound transport operations for its fixed release ref. */
export interface ReleaseHistoryOpsV1 {
  scratchDir: string;
  ref: string;
  loadComplete(op: OpContext): Promise<PortResultV1<LoadedState>>;
  git(op: OpContext, args: string[]): Promise<GitRunResultV1>;
  readTree(
    op: OpContext,
    commit: string,
  ): Promise<PortResultV1<RepairStateSnapshotV1 | ReleaseStateSnapshotV1>>;
}

/** Repair uses the same bound read operations; its stronger close lifecycle is private. */
export async function openRepairHistoryView(
  ops: ReleaseHistoryOpsV1,
  expectedHead: GitSha,
): Promise<PortResultV1<RepairHistoryViewV1>> {
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) {
    return portError("invalid", "historical repair identity is malformed");
  }
  let directory: string;
  try {
    directory = await Deno.makeTempDir({
      prefix: "state-history-repair-",
      dir: ops.scratchDir,
    });
  } catch {
    return portError("unavailable", "repair history directory unavailable");
  }
  const op: OpContext = { directory, treeMemo: new StateTreeMemo() };
  let closed = false;
  let closing: Promise<void> | null = null;
  const active = new Set<Promise<unknown>>();
  const close = () => {
    closed = true;
    return closing ??= (async () => {
      await Promise.allSettled([...active]);
      await removeScratchDirectory(directory);
    })();
  };
  try {
    await Deno.chmod(directory, 0o700);
    const loaded = await ops.loadComplete(op);
    if (
      !loaded.ok || loaded.value.status !== "found" ||
      loaded.value.head !== expectedHead
    ) {
      await close();
      return !loaded.ok
        ? loaded
        : portError("conflict", "historical repair head changed or is absent");
    }
    if (loaded.value.snapshot.kind !== "repair_state_snapshot") {
      await close();
      return portError("invalid", "repair history snapshot kind mismatch");
    }
    return portOk({
      close,
      readAt: (commit: GitSha) => {
        if (closed) {
          return Promise.resolve(
            portError("unavailable", "historical repair view is closed"),
          );
        }
        if (!/^[0-9a-f]{40}$/.test(commit)) {
          return Promise.resolve(
            portError("invalid", "historical repair identity is malformed"),
          );
        }
        const reading = Promise.resolve().then(async () => {
          try {
            const ancestor = await ops.git(op, [
              "merge-base",
              "--is-ancestor",
              commit,
              expectedHead,
            ]);
            if (!ancestor.ok) {
              return portError(
                "invalid",
                "historical repair commit is missing or not an ancestor",
              );
            }
            const snapshot = await ops.readTree(op, commit);
            if (!snapshot.ok) return snapshot;
            if (snapshot.value.kind !== "repair_state_snapshot") {
              return portError(
                "invalid",
                "repair history snapshot kind mismatch",
              );
            }
            return portOk({
              status: "found" as const,
              snapshot: structuredClone(snapshot.value),
              head: commit,
              ref: ops.ref,
            });
          } catch {
            return portError(
              "unavailable",
              "historical repair view read unavailable",
            );
          }
        });
        active.add(reading);
        void reading.then(
          () => active.delete(reading),
          () => active.delete(reading),
        );
        return reading;
      },
    });
  } catch {
    try {
      await close();
    } catch { /* No success or proof survives failed initialization. */ }
    return portError("unavailable", "repair history view unavailable");
  }
}

export async function openReleaseHistoryView(
  ops: ReleaseHistoryOpsV1,
  expectedHead: GitSha,
): Promise<PortResultV1<ReleaseHistoryViewV1>> {
  const malformed = () =>
    portError("invalid", "historical release identity is malformed");
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) return malformed();
  let directory: string;
  try {
    directory = await Deno.makeTempDir({
      prefix: "state-history-",
      dir: ops.scratchDir,
    });
  } catch {
    return portError(
      "unavailable",
      "state operation could not allocate a protected working directory",
    );
  }
  const op: OpContext = { directory };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await removeScratchDirectory(directory);
    } catch {
      // Best-effort scratch cleanup; results are unaffected.
    }
  };
  const loaded = await ops.loadComplete(op);
  if (
    !loaded.ok || loaded.value.status !== "found" ||
    loaded.value.head !== expectedHead
  ) {
    await close();
    if (!loaded.ok) return loaded;
    return portError(
      "conflict",
      "historical release head changed or is absent",
    );
  }
  return portOk({
    close,
    readAt: async (commit: GitSha) => {
      if (closed) {
        return portError("unavailable", "historical release view is closed");
      }
      if (!/^[0-9a-f]{40}$/.test(commit)) return malformed();
      const ancestor = await ops.git(op, [
        "merge-base",
        "--is-ancestor",
        commit,
        expectedHead,
      ]);
      if (!ancestor.ok) {
        return portError(
          "invalid",
          "historical release commit is missing or not an ancestor",
        );
      }
      const snapshot = await ops.readTree(op, commit);
      if (!snapshot.ok) return snapshot;
      return portOk({
        status: "found" as const,
        snapshot: snapshot.value as ReleaseStateSnapshotV1,
        head: commit,
        ref: ops.ref,
      });
    },
  });
}
