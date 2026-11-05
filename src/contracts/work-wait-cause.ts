/**
 * WorkWaitCauseV1 (#335): the concrete, closed cause of one `wait` the
 * trusted step loop wrote, so a record sitting in `backoff`/`unavailable` is
 * explainable without its job log.
 *
 * Additive and optional on `WorkWaitV1`: a wait written before the field
 * existed (or by a writer that does not know its cause) has none. Only a port
 * name, an HTTP status class and a short closed code are stored: never a
 * response body, URL, header, credential or raw upstream text.
 */
import {
  expectEnum,
  expectExactKeys,
  expectPattern,
  expectRecord,
} from "./validation.ts";

export const WAIT_CAUSE_PORTS_V1 = [
  "github",
  "model",
  "budget",
  "queue",
  "state",
  "ci",
  "runtime",
] as const;
export type WaitCausePortV1 = typeof WAIT_CAUSE_PORTS_V1[number];

/** HTTP status class of the failed observation (`none`: no HTTP failure). */
export const WAIT_CAUSE_STATUSES_V1 = [
  "none",
  "4xx",
  "429",
  "5xx",
  "network",
  "unknown",
] as const;
export type WaitCauseStatusV1 = typeof WAIT_CAUSE_STATUSES_V1[number];

export interface WorkWaitCauseV1 {
  port: WaitCausePortV1;
  status: WaitCauseStatusV1;
  /** Short closed reason code (`[a-z0-9_]`, at most 16 characters). */
  code: string;
}

/** Longest code; `port:status:code` then always fits 32 characters. */
export const WAIT_CAUSE_CODE_MAX = 16;
const CODE = /^[a-z0-9_]{1,16}$/;
const CAUSE_KEYS = ["code", "port", "status"] as const;

export function parseWorkWaitCauseV1(
  input: unknown,
  path: string,
): WorkWaitCauseV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CAUSE_KEYS, path);
  return {
    port: expectEnum(obj.port, WAIT_CAUSE_PORTS_V1, `${path}.port`),
    status: expectEnum(obj.status, WAIT_CAUSE_STATUSES_V1, `${path}.status`),
    code: expectPattern(
      obj.code,
      `${path}.code`,
      CODE,
      "invalid_pattern",
      "expected a short closed wait cause code",
      WAIT_CAUSE_CODE_MAX,
    ),
  };
}

/** The bounded histogram key of one cause (`port:status:code`, <= 32 chars). */
export function waitCauseKeyV1(cause: WorkWaitCauseV1): string {
  return `${cause.port}:${cause.status}:${cause.code}`;
}

/** HTTP status class of an observed status code. */
export function waitCauseStatusOfHttp(
  status: number | null | undefined,
): WaitCauseStatusV1 {
  if (status === null || status === undefined) return "unknown";
  if (status === 429) return "429";
  if (status >= 500 && status <= 599) return "5xx";
  if (status >= 400 && status <= 499) return "4xx";
  return "unknown";
}

/**
 * The cause of a failed port result: its HTTP status class when the port
 * observed one, else `429` for a rate limit, else `unknown`; the code is the
 * closed port error kind.
 */
export function waitCauseOfPortError(
  port: WaitCausePortV1,
  error: {
    kind: string;
    issueSource?: { httpStatus: number | null };
    httpStatus?: number | null;
  },
): WorkWaitCauseV1 {
  const http = error.httpStatus ?? error.issueSource?.httpStatus ?? null;
  const status = http !== null
    ? waitCauseStatusOfHttp(http)
    : error.kind === "rate_limited"
    ? "429"
    : "unknown";
  const code = CODE.test(error.kind) ? error.kind : "other";
  return { port, status, code };
}
