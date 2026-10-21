/** Independent deterministic acceptance of the durable native owner-review producer. */
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import {
  type OwnerSuccessorTaskAcceptanceV1,
  parseOwnerSuccessorReviewV1,
  parseOwnerSuccessorTaskAcceptanceV1,
} from "../contracts/owner-successor-review.ts";
import { parseHostedRunProofV1 } from "../contracts/hosted-supervisor.ts";
import type { HostedReleaseRecordV1 } from "../contracts/hosted-supervisor.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { GitHubApiClient } from "../github/client.ts";
import { fetchHttpTransport } from "../github/http.ts";
import { reviewTaskStatementDigest } from "../contracts/review-task-acceptance.ts";
import { verifyReviewSnapshotDigest } from "../github/review-snapshot.ts";
import {
  nativeProof,
  type ReadInput,
} from "./owner-install-future-recovery.ts";
import {
  ownerSupersessionSourceApproved,
  ownerSupersessionSourceData,
} from "./owner-install-supersession-source.ts";
import { ownerStartupNativeQuiescent } from "./owner-install-startup-evidence.ts";
import {
  HOSTED_RUNTIME_ROLLOUT,
  parseHostedRuntimeRollout,
} from "./hosted-runtime-rollout.ts";
import { QUEUE_RUNTIME_CAPABILITY } from "./queue-runtime-capability.ts";
import { EXISTING_PR_RUNTIME_CAPABILITY } from "./existing-pr-runtime-capability.ts";
import { ownerSuccessorBindingFor } from "./owner-successor-acceptance-binding.ts";

const digest = canonicalStringifySha256;
const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
declare const issuedAuthority: unique symbol;
export interface OwnerSuccessorAcceptanceAuthority {
  readonly [issuedAuthority]: true;
}
type Verified = {
  acceptance: OwnerSuccessorTaskAcceptanceV1;
  releaseId: string;
  release: string;
  repair: string;
  repairHead: string;
  releaseHead: string;
};
const issued = new WeakMap<OwnerSuccessorAcceptanceAuthority, Verified>();

export async function ownerSuccessorAcceptanceId(
  review: OwnerSuccessorTaskAcceptanceV1["review"],
): Promise<string> {
  const b = review.binding;
  const fingerprint = await digest({
    domain: "sentinel-owner-successor-task-acceptance-v1",
    releaseId: b.releaseId,
    requestSha256: b.requestSha256,
    intentSha256: b.intentSha256,
    ownerBindingId: b.ownerBindingId,
    ownerBindingSha256: b.ownerBindingSha256,
    successorRevision: b.successorRevision,
    successorGeneration: b.successorGeneration,
    taskSha256: b.taskSha256,
    snapshotSha256: b.snapshot.digest,
    invocationId: b.invocationId,
  });
  return `owner-successor-acceptance:${fingerprint}`;
}

/** Consumer check is exact and digest-complete; it never treats bootstrap as task acceptance. */
export async function ownerSuccessorAcceptanceBinds(
  receipt: HostedReleaseRecordV1,
): Promise<boolean> {
  try {
    const a = receipt.ownerAcceptance, d = receipt.ownerDisposition;
    if (receipt.phase !== "owner_superseded" || !a || !d) return false;
    const parsed = parseOwnerSuccessorTaskAcceptanceV1(a);
    // Historical generic-turn records remain readable, but cannot grant new
    // acceptance authority. The strict native execution parser correlates
    // target, thread, turn and entered/exited items before this predicate.
    if (
      parsed.review.readyExecution?.nativeReview?.mode !== "review/start" ||
      parsed.review.readyExecution.actual.evidenceKind !== "native-review"
    ) return false;
    const b = parsed.review.binding, i = d.intent;
    const selected = await ownerSuccessorBindingFor(
      receipt,
      b.successorRevision,
      b.successorGeneration,
    );
    return parsed.id === await ownerSuccessorAcceptanceId(parsed.review) &&
      parsed.reviewSha256 === await digest(parsed.review) &&
      parsed.review.resultSha256 === await digest(parsed.review.result) &&
      await verifyReviewSnapshotDigest(b.snapshot) &&
      b.releaseId === receipt.id &&
      b.requestSha256 === await digest(receipt.request) &&
      b.requestSha256 === i.requestSha256 &&
      b.intentSha256 === await digest(i) && b.intentSha256 === d.intentSha256 &&
      b.taskSha256 === i.taskSha256 && b.issueNumber === i.issueNumber &&
      b.workId === i.workId && selected !== undefined &&
      b.ownerBindingId === selected.id &&
      b.ownerBindingSha256 === selected.sha256 &&
      b.snapshot.base === selected.binding.acceptanceBaseRevision;
  } catch {
    return false;
  }
}

/** No model port: verifies completed producer, source/native custody and existing charged accounting. */
export async function readOwnerSuccessorAcceptanceAuthority(
  input: ReadInput,
): Promise<OwnerSuccessorAcceptanceAuthority | undefined> {
  try {
    const repair = await input.state.readRepair();
    if (
      !repair.ok || repair.value.status !== "found" ||
      !input.state.readReleaseAt || !input.state.readRepairAt
    ) {
      return;
    }
    const repairHead = repair.value.head,
      repairSnapshot = repair.value.snapshot,
      releaseSnapshot = input.current.snapshot;
    const runtime = releaseSnapshot.hostedRuntimes[0];
    if (!runtime || runtime.execution !== null) {
      return;
    }
    const candidates = [];
    for (const r of releaseSnapshot.hostedReleases) {
      const selected = await ownerSuccessorBindingFor(
        r,
        runtime.activeRevision,
        runtime.generation,
      );
      if (selected && r.ownerAcceptance === undefined) {
        candidates.push({ receipt: r, selected });
      }
    }
    if (candidates.length !== 1) {
      return;
    }
    const { receipt, selected } = candidates[0];
    if (!receipt?.ownerDisposition) {
      return;
    }
    const original = receipt.ownerDisposition.intent;
    const i = selected.binding;
    const pins = parseHostedRuntimeRollout(
      input.rollout ?? HOSTED_RUNTIME_ROLLOUT,
    );
    if (
      !pins.ownerSupersessions.some((r) => same(r, original)) ||
      await digest(original) !== receipt.ownerDisposition.intentSha256 ||
      (selected.id.startsWith("owner-successor-binding:") &&
        !pins.ownerSuccessorTaskBindings.some((r) => same(r, i))) ||
      !same(
        repairSnapshot.releaseRequests.find((r) => r.id === receipt.id),
        receipt.request,
      )
    ) {
      return;
    }
    const operations = repairSnapshot.ownerSuccessorReviews?.filter((r) =>
      r.binding.releaseId === receipt.id &&
      r.binding.intentSha256 === receipt.ownerDisposition!.intentSha256 &&
      r.binding.ownerBindingId === selected.id &&
      r.binding.ownerBindingSha256 === selected.sha256 &&
      r.binding.successorRevision === runtime.activeRevision &&
      r.binding.successorGeneration === runtime.generation
    ) ?? [];
    if (operations.length !== 1) {
      return;
    }
    const review = parseOwnerSuccessorReviewV1(operations[0]);
    const b = review.binding,
      reservation = repairSnapshot.reservations.find((r) =>
        r.id === review.reservation.id
      );
    if (
      review.phase !== "completed" || review.updatedAt > Date.now() ||
      releaseSnapshot.updatedAt > Date.now() ||
      repairSnapshot.updatedAt > Date.now() ||
      !same(reservation, review.reservation) ||
      review.resultSha256 !== await digest(review.result) ||
      !await verifyReviewSnapshotDigest(b.snapshot) ||
      b.successorRevision !== runtime.activeRevision ||
      b.successorGeneration !== runtime.generation ||
      b.snapshot.base !== i.acceptanceBaseRevision ||
      b.ownerBindingId !== selected.id ||
      b.ownerBindingSha256 !== selected.sha256 ||
      b.requestSha256 !== await digest(receipt.request) ||
      b.taskSha256 !== i.taskSha256 || b.issueNumber !== i.issueNumber ||
      b.workId !== i.workId
    ) {
      return;
    }
    const ownerProof = parseHostedRunProofV1(runtime.lastExecutionProof);
    if (
      ownerProof.outcome !== "healthy" ||
      !same(ownerProof.execution, b.nativeOwner) ||
      ownerProof.execution.revision !== runtime.activeRevision ||
      ownerProof.execution.generation !== runtime.generation ||
      !same(runtime.lastHealthyProof, ownerProof)
    ) {
      return;
    }
    const [witness, reserved] = await Promise.all([
      input.state.readReleaseAt({
        commit: b.expectedReleaseHead,
        expectedHead: input.current.head,
      }),
      input.state.readRepairAt({
        commit: b.expectedRepairHead,
        expectedHead: repairHead,
      }),
    ]);
    if (
      !witness.ok || witness.value.status !== "found" || !reserved.ok ||
      reserved.value.status !== "found" ||
      !same(
        witness.value.snapshot.hostedRuntimes[0]?.lastHealthyProof,
        b.health,
      ) ||
      !same(
        witness.value.snapshot.hostedRuntimes[0]?.execution,
        b.nativeOwner,
      ) ||
      !reserved.value.snapshot.reservations.some((r) =>
        r.id === reservation!.id && r.outcome === "reserved" &&
        same({
          ...r,
          outcome: reservation!.outcome,
          settledAt: reservation!.settledAt,
        }, reservation)
      )
    ) {
      return;
    }
    let rateLimited = false;
    const unchanged = async () => {
      const [r, p] = await Promise.all([
        input.state.readRelease(),
        input.state.readRepair(),
      ]);
      return !rateLimited && r.ok && r.value.status === "found" && p.ok &&
        p.value.status === "found" && r.value.head === input.current.head &&
        p.value.head === repairHead &&
        same(r.value.snapshot, releaseSnapshot) &&
        same(p.value.snapshot, repairSnapshot) &&
        ![
          ...r.value.snapshot.githubCooldowns,
          ...p.value.snapshot.githubCooldowns,
        ].some((c) =>
          c.retryNotBefore === null || Date.now() < c.retryNotBefore
        );
    };
    const clock = {
      now() {
        return Date.now();
      },
    };
    const client = new GitHubApiClient({
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      apiBaseUrl: "https://api.github.com",
      http: fetchHttpTransport(),
      auth: {
        authorizationHeader: () =>
          Promise.resolve(portOk(`Bearer ${input.token}`)),
      },
      clock,
      includeIssueRelations: false,
      cooldownGate: {
        beforeRequest: async (scope) =>
          scope === 0 && await unchanged()
            ? portOk(undefined)
            : portError("unavailable", "owner acceptance custody unavailable"),
        recordRateLimit: () => {
          rateLimited = true;
          return Promise.resolve(portOk(undefined));
        },
      },
    });
    const task = await client.readIssue(i.issueNumber);
    if (
      !task.ok || !task.value ||
      await reviewTaskStatementDigest({
          issueNumber: task.value.number,
          title: task.value.title,
          body: task.value.body,
        }) !== i.taskSha256 ||
      !await ownerSupersessionSourceData({
        launcherSha: input.run.launcherSha,
        queue: input.queue ?? QUEUE_RUNTIME_CAPABILITY,
        custody: input.custody ?? EXISTING_PR_RUNTIME_CAPABILITY,
        rollout: pins,
      }) ||
      !await ownerSupersessionSourceApproved(input, {
        ...original,
        toRevision: i.successorRevision,
        toGeneration: i.successorGeneration,
        controllerSourceRevision: i.controllerSourceRevision,
        controllerCodeSha256: i.controllerCodeSha256,
        ciRevision: i.ciRevision,
      }, Date.now()) || !await nativeProof(client, b.health) ||
      !await nativeProof(client, ownerProof) ||
      !await ownerStartupNativeQuiescent(input.token, input.run) ||
      !await unchanged()
    ) {
      return;
    }
    const acceptance = parseOwnerSuccessorTaskAcceptanceV1({
      version: "v1",
      kind: "owner_successor_task_acceptance",
      id: await ownerSuccessorAcceptanceId(review),
      review,
      reviewSha256: await digest(review),
      nativeOwnerProof: ownerProof,
      expectedRepairHead: repairHead,
      expectedReleaseHead: input.current.head,
      producerRevision: runtime.activeRevision,
      controllerRevision: input.run.launcherSha,
      controllerRun: { ...input.run },
      createdAt: review.updatedAt,
    });
    // This same predicate gates issuance as well as delivery reuse, so a
    // readable historical review cannot be wrapped into new authority.
    if (
      !await ownerSuccessorAcceptanceBinds({
        ...receipt,
        ownerAcceptance: acceptance,
      })
    ) {
      return;
    }
    const authority = Object.freeze({}) as OwnerSuccessorAcceptanceAuthority;
    issued.set(authority, {
      acceptance,
      releaseId: receipt.id,
      release: canonicalStringify(releaseSnapshot),
      repair: canonicalStringify(repairSnapshot),
      repairHead,
      releaseHead: input.current.head,
    });
    return authority;
  } catch {
    return undefined;
  }
}

export function consumeOwnerSuccessorAcceptance(
  authority: OwnerSuccessorAcceptanceAuthority,
  input: ReadInput,
): OwnerSuccessorTaskAcceptanceV1 {
  const proof = issued.get(authority);
  if (
    !proof || proof.releaseHead !== input.current.head ||
    proof.release !== canonicalStringify(input.current.snapshot)
  ) throw new Error("owner acceptance authority unavailable");
  return structuredClone(proof.acceptance);
}
export async function ownerSuccessorAcceptanceUnchanged(
  input: ReadInput,
  authority: OwnerSuccessorAcceptanceAuthority,
): Promise<boolean> {
  const expected = issued.get(authority),
    refreshed = await readOwnerSuccessorAcceptanceAuthority(input);
  return expected !== undefined && refreshed !== undefined &&
    same(expected, issued.get(refreshed));
}
