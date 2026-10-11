/**
 * Deterministic release controller: the exclusive release ownership state
 * machine.
 *
 * The controller consumes `StateReadView` (repair requests + release records)
 * and `ReleaseStateWriter` (release records only) plus `DenoReleasePort`, the
 * trusted build-receipt resolver capability and `Clock`. It never touches
 * repair/budget/code state, never uses a model, and every release record it
 * writes is re-parseable by the frozen parser (records are built through
 * parseReleaseRecordV1).
 *
 * Sequence per release:
 * 1. Resolve the exact build receipt (trusted resolver keyed by the request);
 *    absent/ambiguous/unavailable waits/blocks without promotion.
 * 2. Verify exactly one matched build on the platform.
 * 3. Attest the exact healthy prior identity on the managed domain and record
 *    candidate + prior (phase `requested`).
 * 4. Persist promote intent (phase `promoting`), then promote and require
 *    HTTP 204 plus post-effect managed identity proof.
 * 5. Monitor with persisted 30-second window slots; a missed slot or an
 *    unverifiable health observation restarts the window (interrupted
 *    continuity is never reconstructed).
 * 6. Evaluate the owner policy: a threshold breach is objective failure and
 *    rolls back; missing/insufficient evidence is failed acceptance without
 *    rollback.
 * 7. Rollback re-observes actual candidate ownership, then restores the exact
 *    recorded prior and proves restoration; a conflicting unrelated newer
 *    deployment blocks instead of rolling back.
 *
 * Requests already accepted or rolled back stay terminal (the state store
 * refuses to mutate terminal records).
 */
import type { PortResultV1 } from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import { ReleaseControllerState } from "./controller-state.ts";
import type {
  ReleaseControllerOptions,
  ReleaseCycleResultV1,
} from "./controller-common.ts";
import {
  beginRequest,
  continueRecord,
  firstEligibleRequest,
} from "./controller-request.ts";
export type {
  ReleaseControllerOptions,
  ReleaseCycleResultV1,
} from "./controller-common.ts";

export class ReleaseController {
  private readonly state: ReleaseControllerState;

  constructor(options: ReleaseControllerOptions) {
    this.state = new ReleaseControllerState(options);
  }

  async run(): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const context = await this.state.loadContext();
    if (context === null) {
      return portOk({
        status: "blocked",
        recordId: null,
        detail: "release state is unavailable",
        warnings: [],
      });
    }
    if (context.active.length > 1) {
      return portOk({
        status: "blocked",
        recordId: null,
        detail: "multiple concurrent releases target the same environment",
        warnings: [],
      });
    }
    if (context.active.length === 1) {
      return continueRecord(this.state, context.active[0], context);
    }
    const next = firstEligibleRequest(context);
    if (next === null) return portOk({ status: "idle", warnings: [] });
    return beginRequest(this.state, next, context);
  }
}
