import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  ReviewJournalExecutionV1,
  ReviewJournalReadyExecutionV1,
  ReviewResultV1,
} from "../../src/github/review-journal.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import { type FakeGithub, REPO, T0 } from "./helpers.ts";
import assert from "node:assert/strict";
import type { ReviewSnapshotV1 } from "../../src/github/review-snapshot.ts";
import { reviewSnapshotDigest } from "../../src/github/review-snapshot.ts";
import type {
  PreparedStructuredReviewV1,
  StructuredReviewOutcomeV1,
  StructuredReviewPrepareV1,
} from "../../src/github/codex-reviewer.ts";
import { createHash } from "node:crypto";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { renderReviewPrompt } from "../../src/github/review-snapshot.ts";
import { nativeReviewInstructions } from "../../src/github/native-review-result.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { GitHubCodexReviewTransport } from "../../src/github/codex-review-transport.ts";
import type {
  ReviewDrainReportV1,
  ReviewObservationRequestV1,
} from "../../src/contracts/ports.ts";
import type { GitHubApiClient } from "../../src/github/client.ts";
import { normalizeReviewObservation } from "../../src/github/review-normalize.ts";

// ---------------------------------------------------------------------------
// T03 v3: mandatory review drain through the ACTUAL repair entrypoint.
//
// `github.requestReview` submits through the real concrete
// `GitHubCodexReviewTransport` and `github.drainReviews` is the same
// transport's mandatory entrypoint drain — the entrypoint itself invokes it.
// The only doubles are the external HTTP surface (an in-memory review REST
// store), the trusted snapshot capture and the producer prepare capability
// (no model session is opened). No multi-second sleeps: the delayed review
// settles after a finite millisecond timer.
// ---------------------------------------------------------------------------

export const TRANSPORT_PUBLISHER = "chatgpt-codex-connector[bot]";
const TRANSPORT_REVIEW_ID = 100;
export const SECOND_HEAD = "9".repeat(40) as GitSha;
export const SECOND_FINGERPRINT = "c".repeat(64);

export const CLEAN_REVIEW_RESULT: ReviewResultV1 = {
  verdict: "clean",
  summary: "The supplied change matches the specification.",
  findings: [],
};

interface StoredReviewV1 {
  id: number;
  prNumber: number;
  author: string;
  state: "pending" | "commented";
  body: string | null;
  head: GitSha;
  submittedAt: number | null;
}

function transportResponse(status: number, value: unknown): HttpResponseV1 {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    bodyText: JSON.stringify(value),
  };
}

function storedReviewJson(review: StoredReviewV1): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: review.id,
    user: { login: review.author },
    state: review.state === "pending" ? "PENDING" : "COMMENTED",
    body: review.body,
    commit_id: review.head,
  };
  if (review.state === "commented") {
    wire.submitted_at = new Date(review.submittedAt ?? T0).toISOString();
  }
  return wire;
}

/** Minimal in-memory GitHub review REST surface (external HTTP only). */
export class ReviewRestStore {
  readonly reviews = new Map<number, StoredReviewV1>();
  nextId = TRANSPORT_REVIEW_ID;
  creates = 0;
  updates = 0;
  submits = 0;

  handle = (request: HttpRequestV1): Promise<HttpResponseV1> => {
    const path = request.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const list = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(path);
    const exact = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)$/.exec(
      path,
    );
    const events =
      /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)\/events$/.exec(
        path,
      );
    if (request.method === "GET" && list !== null) {
      const prNumber = Number(list[1]);
      return Promise.resolve(transportResponse(
        200,
        [...this.reviews.values()]
          .filter((review) => review.prNumber === prNumber)
          .map(storedReviewJson),
      ));
    }
    if (request.method === "GET" && exact !== null) {
      const review = this.reviews.get(Number(exact[2]));
      if (review === undefined) {
        return Promise.resolve(
          transportResponse(404, { message: "Not Found" }),
        );
      }
      return Promise.resolve(transportResponse(200, storedReviewJson(review)));
    }
    if (request.method === "POST" && list !== null) {
      this.creates++;
      const payload = JSON.parse(request.body ?? "{}") as {
        commit_id: GitSha;
        body: string;
      };
      const created: StoredReviewV1 = {
        id: this.nextId++,
        prNumber: Number(list[1]),
        author: TRANSPORT_PUBLISHER,
        state: "pending",
        body: payload.body,
        head: payload.commit_id,
        submittedAt: null,
      };
      this.reviews.set(created.id, created);
      return Promise.resolve(transportResponse(201, storedReviewJson(created)));
    }
    if (request.method === "PUT" && exact !== null) {
      this.updates++;
      const review = this.reviews.get(Number(exact[2]));
      if (review === undefined) {
        return Promise.resolve(
          transportResponse(404, { message: "Not Found" }),
        );
      }
      const payload = JSON.parse(request.body ?? "{}") as { body: string };
      review.body = payload.body;
      return Promise.resolve(transportResponse(200, storedReviewJson(review)));
    }
    if (request.method === "POST" && events !== null) {
      this.submits++;
      const review = this.reviews.get(Number(events[2]));
      if (review === undefined) {
        return Promise.resolve(
          transportResponse(404, { message: "Not Found" }),
        );
      }
      const payload = JSON.parse(request.body ?? "{}") as {
        event: string;
        body: string;
      };
      assert.equal(payload.event, "COMMENT");
      review.state = "commented";
      review.submittedAt = T0;
      review.body = payload.body;
      return Promise.resolve(transportResponse(200, storedReviewJson(review)));
    }
    return Promise.resolve(transportResponse(404, { message: "unexpected" }));
  };
}

export async function trustedSnapshot(
  base: GitSha,
  head: GitSha,
): Promise<ReviewSnapshotV1> {
  const draft: ReviewSnapshotV1 = {
    version: "v1",
    base,
    head,
    mergeBase: base,
    files: [{
      path: "src/app.ts",
      kind: "modified",
      oldBlob: "1".repeat(40),
      newBlob: "2".repeat(40),
      oldMode: "100644",
      newMode: "100644",
      candidateLines: 3,
    }],
    digest: "",
  };
  return { ...draft, digest: await reviewSnapshotDigest(draft) };
}

/** Delayed clean producer session: `start` settles after a finite timer. */
export function preparedCleanReview(
  request: StructuredReviewPrepareV1,
  delayMs: number,
  result: ReviewResultV1 = CLEAN_REVIEW_RESULT,
  beforeResult: () => Promise<void> = () => Promise.resolve(),
): PreparedStructuredReviewV1 {
  const target = {
    type: "custom",
    instructions: renderReviewPrompt(request.snapshot, request.task ?? null) +
      "\n\n" +
      nativeReviewInstructions(
        request.snapshot,
        request.task ?? null,
        "/fixture/review",
      ),
  };
  const targetDigest = createHash("sha256").update(canonicalStringify(target))
    .digest("hex");
  // Prepared/running identity: exactly ReviewJournalExecutionV1. The transport
  // persists this object into the RUNNING journal before `start`, whose parser
  // rejects terminal-only keys (turnId/resultId/actual).
  const execution: ReviewJournalExecutionV1 = {
    ownerRunId: request.ownerRunId,
    invocationId: request.invocationId,
    threadId: "thread-1",
    submittedProvider: "openai",
    model: null,
    reasoning: null,
    nativeReview: { mode: "review/start", targetDigest },
    startMayOccur: true,
  };
  let attempted = false;
  return {
    execution,
    threadId: "thread-1",
    invocationId: request.invocationId,
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    latestStartAt: request.latestStartAt,
    settleBy: request.settleBy,
    startAttempted: () => attempted,
    start: async () => {
      attempted = true;
      await beforeResult();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // Terminal fields exist only on the successful start outcome, which the
      // transport persists into the READY journal.
      const ready: ReviewJournalReadyExecutionV1 = {
        ...execution,
        turnId: "turn-1",
        resultId: "result-9",
        actual: {
          evidenceKind: "native-review",
          provider: "openai",
          threadId: "thread-1",
          turnId: "turn-1",
          terminalOrigin: "runtime",
          observedTerminalStatus: "completed",
          observedModel: null,
          observedReasoning: null,
          nativeReview: {
            targetDigest,
            reviewThreadId: "thread-1",
            enteredItemId: "entered-review-1",
            exitedItemId: "result-9",
          },
          durationMs: 5,
          outputChars: 10,
        },
      };
      return portOk(
        {
          status: "clean",
          result,
          resultId: ready.resultId,
          actual: ready.actual,
          execution: ready,
          detail: null,
        } satisfies StructuredReviewOutcomeV1,
      );
    },
    close: () =>
      Promise.resolve({ settled: true, failure: null, timedOut: false }),
  };
}

/**
 * Wire the concrete review transport into the exact GitHubPort instance the
 * entrypoint consumes: submission and the mandatory drain both flow through
 * the real transport (the port's other operations stay the deterministic
 * lifecycle fake).
 */
export function wireConcreteReviewTransport(
  github: FakeGithub,
  transport: GitHubCodexReviewTransport,
  reports: ReviewDrainReportV1[],
  now: () => number,
  client?: GitHubApiClient,
): void {
  if (client !== undefined) {
    github.observeReview = async (input) => {
      const request = input as ReviewObservationRequestV1;
      github.calls.push("observeReview");
      github.observedReviewKeys.push(request.operationKey);
      const service = await transport.readReview({
        operationKey: request.operationKey,
        requestId: null,
        prNumber: request.prNumber,
      });
      if (!service.ok) return service;
      const pull = await github.readPullRequest(request.prNumber);
      if (!pull.ok) return pull;
      const reviews = await client.readReviews(request.prNumber);
      if (!reviews.ok) return reviews;
      return normalizeReviewObservation({
        request,
        service: service.value,
        repository: REPO,
        expectedOperationKey: request.operationKey,
        pullRequest: pull.value,
        reviews: reviews.value,
        comments: [],
        expectedReviewer: github.reviewerIdentity,
        findingCap: 100,
        receivedAt: now(),
      });
    };
  }
  github.requestReview = async (request) => {
    github.calls.push("requestReview");
    const submitted = await transport.submitReview(
      request as Parameters<GitHubCodexReviewTransport["submitReview"]>[0],
    );
    if (!submitted.ok) return submitted;
    switch (submitted.value.status) {
      case "submitted":
        return portOk({
          outcome: "applied" as const,
          requestId: submitted.value.requestId,
          requestedAt: submitted.value.requestedAt,
        });
      case "ambiguous":
        return portOk({
          outcome: "ambiguous" as const,
          requestId: null,
          requestedAt: now(),
        });
      case "rejected":
        return portError("conflict", "review request was rejected");
      default:
        return portError("unavailable", "review submission status is unknown");
    }
  };
  github.drainReviews = async (request) => {
    const result = await transport.drain(request);
    reports.push(result);
    return portOk(result);
  };
}
