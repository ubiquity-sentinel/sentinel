/**
 * The lifecycle's admissible initial states, state identity and indefinite
 * waits (`pipeline.ts` re-exports them).
 */
import { isWaiting } from "../../src/repair/selection.ts";
import type { Phase, PStateV1 } from "./pipeline.ts";
import { NOW } from "./world.ts";

/** Every admissible abstract state (the exploration's initial states). */
export function initialStates(): PStateV1[] {
  const phases: Phase[] = [
    "work.fresh",
    "work.impl",
    "work.noted",
    "work.published",
    "work.ci_wait",
    "work.base_red",
    "work.refresh",
    "review.requested",
    "delivery.gate",
    "delivery.ci_wait",
    "delivery.base_red",
    "delivery.refresh",
    "delivery.carried",
    "delivery.merge",
    "delivery.released",
    "delivery.closure",
  ];
  const states: PStateV1[] = [];
  for (const phase of phases) {
    for (const rounds of [0, 1, 2, 3]) {
      // A reviewed phase has spent at least one round.
      if (
        (phase.startsWith("review.") || phase.startsWith("delivery.")) &&
        rounds === 0
      ) continue;
      for (const fixes of [0, 1, 2, 3]) {
        // Unpublished phases start with no PR or with the open one a park or
        // correction kept (nothing spent without a PR); later ones have it.
        const prs = phase === "work.fresh" || phase === "work.impl" ||
            phase === "work.noted"
          ? (rounds === 0 && fixes === 0
            ? ["none", "open"] as const
            : ["open"] as const)
          : ["open"] as const;
        for (const repo of ["self", "gateway"] as const) {
          for (const pr of prs) {
            states.push({
              phase,
              rounds,
              fixes,
              refreshFail: 0,
              carried: 0,
              aged: false,
              moved: false,
              repo,
              pr,
            });
          }
        }
      }
    }
  }
  return states;
}

export function key(state: PStateV1): string {
  return `${state.phase}|r${state.rounds}|f${state.fixes}|b${state.refreshFail}|c${state.carried}|${
    state.aged ? "aged" : "-"
  }|${state.moved ? "moved" : "-"}|${state.repo}|pr:${state.pr}`;
}

/** The abstract waits the runtime never ends on its own (until === null). */
export function indefiniteWaits(): { phase: Phase; reason: string }[] {
  const out: { phase: Phase; reason: string }[] = [];
  for (
    const [phase, reason] of [
      ["work.manual", "manual"],
      ["delivery.review_pending_null", "review_pending"],
    ] as const
  ) {
    // The real selector: a wait with `until: null` is waiting at any time.
    const waiting = isWaiting(
      { wait: { reason, since: NOW, until: null } } as never,
      Number.MAX_SAFE_INTEGER,
    );
    if (waiting) out.push({ phase, reason });
  }
  return out;
}
