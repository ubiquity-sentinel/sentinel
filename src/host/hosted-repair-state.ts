/**
 * The hosted runtime's repair state store, with the read-only view of the
 * launcher's open delivery trains (sentinel #330) on the same state remote
 * and credentials: the trains sidecar `refs/heads/sentinel-state/trains` is
 * read here and never written (the launcher delivery pass is its only
 * writer).
 */
import type {
  DeliveryTrainHoldV1,
  DeliveryTrainJournalV1,
} from "../contracts/delivery-train-ledger.ts";
import type { CiMinuteTrainLandingReaderV1 } from "../contracts/ci-minute-budget.ts";
import type { Clock } from "../contracts/ports.ts";
import {
  portError,
  type PortResultV1,
  type StateReadView,
} from "../contracts/ports.ts";
import { GitDeliveryTrainStore } from "../state/delivery-train-store.ts";
import {
  createRepairStateStore,
  type DenoGitRunner,
  type RepairGitStateStore,
} from "../state/mod.ts";
import { joinPath } from "./local.ts";

export type HostedRepairStateStoreV1 = RepairGitStateStore & {
  readDeliveryTrainHolds(): Promise<
    PortResultV1<readonly DeliveryTrainHoldV1[]>
  >;
};

/** Only exact producer-verified landing data escapes; no writer or token does. */
export function createVerifiedTrainLandingReader(
  journal: Pick<DeliveryTrainJournalV1, "read">,
  clock: Clock,
): CiMinuteTrainLandingReaderV1 {
  return async (effect, revision, deadline) => {
    if (
      effect.kind !== "merge" || effect.pr === null || effect.head === null ||
      effect.base === null || !/^[0-9a-f]{40}$/.test(revision) ||
      !Number.isSafeInteger(deadline) || clock.now() >= deadline
    ) return null;
    let read;
    try {
      read = await journal.read(effect.repository);
    } catch {
      return null;
    }
    if (read === null || clock.now() >= deadline) return null;
    const matches = read.ledger.landings.filter((landing) =>
      landing.pullRequest === effect.pr && landing.head === effect.head &&
      landing.landedOn === effect.base && landing.revision === revision
    );
    return matches.length === 1 ? structuredClone(matches[0]) : null;
  };
}

export function createHostedRepairStateStore(input: {
  scratch: string;
  remoteUrl: string;
  runner: DenoGitRunner;
  clock?: Clock;
  onTrainLandingReader?(reader: CiMinuteTrainLandingReaderV1): void;
}): HostedRepairStateStoreV1 {
  const store = createRepairStateStore({
    scratchDir: input.scratch,
    remoteUrl: input.remoteUrl,
    runner: input.runner,
  });
  const trains = new GitDeliveryTrainStore({
    scratchDir: joinPath(input.scratch, "delivery-trains"),
    remoteUrl: input.remoteUrl,
    runner: input.runner,
  });
  input.onTrainLandingReader?.(
    createVerifiedTrainLandingReader(
      trains,
      input.clock ?? { now: () => Date.now() },
    ),
  );
  return Object.assign(store, {
    readDeliveryTrainHolds: () => trains.readHolds(),
  });
}

/**
 * A matrix cell's state: literal read capabilities (the train holds
 * included) and a refusing write adapter, so no helper can reach the remote
 * repair writer in a cell job.
 */
export function hostedCellState(
  store: Pick<
    StateReadView,
    "readRepair" | "readRelease" | "readDeliveryTrainHolds"
  >,
) {
  return {
    readRepair: () => store.readRepair(),
    readRelease: () => store.readRelease(),
    ...(store.readDeliveryTrainHolds === undefined ? {} : {
      readDeliveryTrainHolds: () => store.readDeliveryTrainHolds!(),
    }),
    writeRepair: () =>
      Promise.resolve(
        portError("invalid", "matrix cells cannot write shared state"),
      ),
  };
}
