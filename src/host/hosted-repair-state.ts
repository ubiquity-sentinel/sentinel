/**
 * The hosted runtime's repair state store, with the read-only view of the
 * launcher's open delivery trains (sentinel #330) on the same state remote
 * and credentials: the trains sidecar `refs/heads/sentinel-state/trains` is
 * read here and never written (the launcher delivery pass is its only
 * writer).
 */
import type { DeliveryTrainHoldV1 } from "../contracts/delivery-train-ledger.ts";
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

export function createHostedRepairStateStore(input: {
  scratch: string;
  remoteUrl: string;
  runner: DenoGitRunner;
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
