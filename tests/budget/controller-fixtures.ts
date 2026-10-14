/** Shared fixtures only; this module registers no tests. */
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { T0 } from "../state/helpers.ts";
import type { FakeClock, MemoryRepairState } from "./helpers.ts";
import { repositoryConfig } from "./helpers.ts";

export function snapshot(
  overrides: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
    ...overrides,
  });
}

export function budget(
  clock: FakeClock,
  state: MemoryRepairState,
  configs: ReturnType<typeof repositoryConfig>[] = [repositoryConfig()],
): RollingStartBudget {
  return new RollingStartBudget({ clock, state, configs });
}
