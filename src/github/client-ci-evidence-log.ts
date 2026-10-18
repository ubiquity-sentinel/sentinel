/**
 * Bounded streaming read of one signed Actions job log for CI failure
 * evidence. The signed URL was validated against the fixed results host
 * (`trustedActionsLogUrl`) and is fetched with no credential, only a `range`
 * header. The log is read in explicit `bytes=start-end` chunks (the results
 * host honors explicit ranges and ignores suffix ranges) and fed to the
 * streaming scanner, so a large log never has to fit one response: the first
 * `MAX_CI_LOG_SCAN_BYTES` are scanned, then only the last
 * `CI_LOG_TAIL_BYTES`, with the gap marked. A host that ignores Range is used
 * when its whole body fits both the transport's body bound and the scan
 * bound, and refused as `oversize` when not.
 * A fired deadline, a refused request or a failed transfer keeps what was
 * already scanned and reports why it stopped.
 */
import {
  type DeadlineV1,
  HTTP_BODY_BOUND_ERROR,
  type HttpResponseV1,
  type HttpTransportV1,
} from "./http.ts";
import {
  type CiFailedStepWindowV1,
  CiLogScanner,
  type CiScannedLogV1,
} from "../repair/ci-evidence-excerpt.ts";
import {
  CI_LOG_CHUNK_BYTES,
  CI_LOG_TAIL_BYTES,
  type CiEvidenceReasonV1,
  MAX_CI_LOG_SCAN_BYTES,
} from "../repair/ci-evidence-types.ts";

export interface SignedLogReadV1 {
  log: CiScannedLogV1 | null;
  /** Only the start and the end of the log were read. */
  truncated: boolean;
  reason: CiEvidenceReasonV1 | null;
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

class LogReadStop extends Error {
  constructor(readonly reason: CiEvidenceReasonV1) {
    super(reason);
  }
}

function bodyBytes(response: HttpResponseV1): Uint8Array {
  return response.bodyBytes ?? new TextEncoder().encode(response.bodyText);
}

function signedStatusReason(status: number): CiEvidenceReasonV1 {
  if (status === 403 || status === 410) return "expired";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

export async function readSignedCiLog(input: {
  http: HttpTransportV1;
  url: string;
  deadline: DeadlineV1;
  /** Counts one request against the collection's bound; false refuses it. */
  takeRequest: () => boolean;
  /** Same-head job API timing; advisory selection only, never log identity. */
  failedSteps?: readonly CiFailedStepWindowV1[];
}): Promise<SignedLogReadV1> {
  const scanner = new CiLogScanner(input.failedSteps);
  let offset = 0;
  let truncated = false;
  const fetchRange = async (start: number, end: number) => {
    if (input.deadline.fired()) throw new LogReadStop("timeout");
    if (!input.takeRequest()) throw new LogReadStop("request_bound");
    const call = Promise.resolve().then(() =>
      input.http({
        method: "GET",
        url: input.url,
        headers: new Map([["range", `bytes=${start}-${end}`]]),
        body: null,
        redirect: "error",
        responseType: "bytes",
      })
    );
    call.catch(() => {});
    return await input.deadline.race(call);
  };
  const ranged = (response: HttpResponseV1, start: number, end: number) => {
    if (response.status !== 206) {
      throw new LogReadStop(signedStatusReason(response.status));
    }
    const match = CONTENT_RANGE.exec(
      response.headers.get("content-range") ?? "",
    );
    const bytes = bodyBytes(response);
    if (match === null) throw new LogReadStop("malformed");
    const first = Number(match[1]);
    const last = Number(match[2]);
    if (
      first !== start || last < first || last > end ||
      bytes.length !== last - first + 1
    ) throw new LogReadStop("malformed");
    return {
      bytes,
      next: last + 1,
      total: match[3] === "*" ? null : Number(match[3]),
    };
  };
  const done = (reason: CiEvidenceReasonV1 | null = null) => ({
    log: scanner.finish(),
    truncated,
    reason,
  });
  try {
    for (;;) {
      const end = offset + CI_LOG_CHUNK_BYTES - 1;
      const response = await fetchRange(offset, end);
      if (response.status === 200 && offset === 0) {
        const bytes = bodyBytes(response);
        if (bytes.length > MAX_CI_LOG_SCAN_BYTES) {
          return { log: null, truncated: false, reason: "oversize" };
        }
        scanner.pushBytes(bytes);
        return done();
      }
      if (response.status === 416 && offset === 0) return done();
      const chunk = ranged(response, offset, end);
      scanner.pushBytes(chunk.bytes);
      offset = chunk.next;
      if (chunk.total !== null && offset >= chunk.total) return done();
      if (chunk.total === null && chunk.bytes.length < CI_LOG_CHUNK_BYTES) {
        return done();
      }
      if (offset < MAX_CI_LOG_SCAN_BYTES) continue;
      truncated = true;
      if (chunk.total === null) return done("oversize");
      const tailStart = Math.max(offset, chunk.total - CI_LOG_TAIL_BYTES);
      if (tailStart > offset) scanner.gap(tailStart - offset);
      const tail = ranged(
        await fetchRange(tailStart, chunk.total - 1),
        tailStart,
        chunk.total - 1,
      );
      scanner.pushBytes(tail.bytes);
      return done();
    }
  } catch (error) {
    // A host that ignores Range and sends more than the transport's body
    // bound fails in the transport itself: that is an oversized log too.
    const reason = input.deadline.fired()
      ? "timeout"
      : error instanceof LogReadStop
      ? error.reason
      : error instanceof Error && error.message === HTTP_BODY_BOUND_ERROR
      ? "oversize"
      : "unavailable";
    return {
      log: offset > 0 ? scanner.finish() : null,
      truncated,
      reason,
    };
  }
}
