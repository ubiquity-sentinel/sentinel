/** Actual producer state, distinct from object availability or descriptor syntax. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  TakeoverCandidateCustody,
  TakeoverProofRequest,
} from "../contracts/existing-pr-takeover.ts";
import {
  type Clock,
  portError,
  portOk,
  type PortResultV1,
  type StateReadView,
} from "../contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  readTakeoverAnchor,
  TAKEOVER_EVIDENCE_NAMESPACE,
} from "../github/existing-pr-takeover-provenance.ts";
import { resolveCandidatePreservationBinding } from "./actions-candidates-preserve.ts";

const same = (left: unknown, right: unknown) =>
  canonicalStringify(left) === canonicalStringify(right);
const unavailable = () =>
  portError("unavailable", "existing PR producer ancestry unavailable");

/** Every historical read is anchored to the current authoritative head; no temporal guesses. */
export function createTakeoverProducerReader(input: {
  state: Pick<StateReadView, "readRepair" | "readRepairAt">;
  clock: Clock;
}) {
  return async (
    request: TakeoverProofRequest,
  ): Promise<
    PortResultV1<Exclude<TakeoverCandidateCustody, { kind: "native" }> | null>
  > => {
    try {
      const live = () =>
        Number.isSafeInteger(request.deadline) &&
        input.clock.now() < request.deadline;
      if (!live() || input.state.readRepairAt === undefined) {
        return unavailable();
      }
      const before = await input.state.readRepair();
      if (
        !before.ok || before.value.status !== "found" ||
        before.value.head !== request.expectedStateHead ||
        !same(before.value.snapshot, request.snapshot)
      ) return unavailable();
      const candidate = request.candidate ??
        request.record.target.candidateState?.preserved;
      if (candidate === undefined || candidate === null) return portOk(null);
      const anchor = await readTakeoverAnchor({
        ...request,
        state: input.state,
      });
      if (anchor === null) return unavailable();
      let snapshot = parseRepairStateSnapshotV1(before.value.snapshot);
      let commit = before.value.head;
      while (live() && commit !== anchor.stateHead) {
        const producer = snapshot.work.find((row) =>
          row.id === request.record.id
        );
        if (
          producer === undefined ||
          !same(producer.repository, request.record.repository) ||
          !same(producer.source, request.record.source) ||
          !same(producer.related, request.record.related) ||
          !same(
            producer.evidence.filter((row) =>
              row.ref.startsWith(TAKEOVER_EVIDENCE_NAMESPACE)
            ),
            request.record.evidence.filter((row) =>
              row.ref.startsWith(TAKEOVER_EVIDENCE_NAMESPACE)
            ),
          ) ||
          producer.target.pr !== request.record.target.pr ||
          producer.target.branch !== request.record.target.branch
        ) return unavailable();
        const publishedHead = producer.target.candidateState?.publishedHead;
        if (publishedHead !== undefined) {
          const binding = await resolveCandidatePreservationBinding(
            producer,
            snapshot.reservations,
            candidate,
            publishedHead,
          );
          if (binding.ok) {
            const intent = producer.intent!;
            // In-flight conflict producers have a distinct charged contract and are
            // not represented by this tranche's two accepted producer kinds.
            if (
              intent.kind !== "candidate_preservation" &&
              intent.kind !== "base_refresh"
            ) return unavailable();
            const custody: Exclude<
              TakeoverCandidateCustody,
              { kind: "native" }
            > = intent.kind === "candidate_preservation"
              ? {
                kind: "implementation",
                reservationId: intent.requestId!,
                candidate,
              }
              : {
                kind: "base_refresh",
                predecessor: producer.target.head!,
                candidate,
              };
            const after = await input.state.readRepair();
            return live() && after.ok && after.value.status === "found" &&
                after.value.head === before.value.head &&
                same(after.value.snapshot, before.value.snapshot)
              ? portOk(custody)
              : unavailable();
          }
        }
        const parent = snapshot.stateHead;
        if (parent === null || parent === commit) return unavailable();
        const read = await input.state.readRepairAt({
          commit: parent,
          expectedHead: request.expectedStateHead,
        });
        if (
          !read.ok || read.value.status !== "found" ||
          read.value.head !== parent
        ) return unavailable();
        const previous = parseRepairStateSnapshotV1(read.value.snapshot);
        if (previous.sequence >= snapshot.sequence) return unavailable();
        snapshot = previous;
        commit = parent;
      }
      return unavailable();
    } catch {
      return unavailable();
    }
  };
}
