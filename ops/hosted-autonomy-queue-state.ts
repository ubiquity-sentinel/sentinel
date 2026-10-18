/** Ordinary maintenance cannot consume custody owned by the queue coordinator. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  portError,
  type RepairStateWriter,
  type StateReadView,
} from "../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { HostedQueueCustodyContext } from "./hosted-autonomy-queue-context.ts";
import { queueProtectedIds } from "./hosted-autonomy-queue-context.ts";

function protectedProjection(
  snapshot: RepairStateSnapshotV1,
  ids: ReadonlySet<string>,
): string {
  const records = snapshot.work.filter((row) => ids.has(row.id));
  const pulls = new Set(
    records.map((row) =>
      `${row.repository.installationId}:${row.repository.owner}/${row.repository.name}:${row.target.pr}`
    ),
  );
  return canonicalStringify({
    work: records,
    reservations: snapshot.reservations.filter((row) => ids.has(row.taskId)),
    reviews: snapshot.reviews.filter((row) =>
      pulls.has(
        `${row.repository.installationId}:${row.repository.owner}/${row.repository.name}:${row.pullRequest.number}`,
      )
    ),
    releaseRequests: snapshot.releaseRequests.filter((row) =>
      pulls.has(
        `${row.target.repository.installationId}:${row.target.repository.owner}/${row.target.repository.name}:${row.source.pullRequest}`,
      )
    ),
    attemptMemory: snapshot.attemptMemory.filter((row) => ids.has(row.taskId)),
  });
}

export function protectQueueState(
  state: StateReadView & RepairStateWriter,
  context: HostedQueueCustodyContext,
): StateReadView & RepairStateWriter {
  // Preserve optional history methods and their original receiver.
  return new Proxy(state, {
    get(target, key) {
      if (key !== "writeRepair") {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (
        next: RepairStateSnapshotV1,
        expectedHead: Parameters<RepairStateWriter["writeRepair"]>[1],
      ) => {
        if (!context.ready || expectedHead === null) {
          return portError("unavailable", "queue custody not ready");
        }
        const before = await state.readRepair();
        if (
          !before.ok || before.value.status !== "found" ||
          before.value.head !== expectedHead
        ) {
          return portError("unavailable", "queue custody state changed");
        }
        const ids = queueProtectedIds(
          before.value.snapshot,
          context.protectedRecordIds,
        );
        if (
          protectedProjection(before.value.snapshot, ids) !==
            protectedProjection(next, ids)
        ) {
          if (
            await context.verifyProtectedWrite?.(
              before.value.snapshot,
              next,
              expectedHead,
            ) !== true
          ) {
            return portError("unavailable", "queue protected record changed");
          }
        }
        return await state.writeRepair(next, expectedHead);
      };
    },
  });
}
