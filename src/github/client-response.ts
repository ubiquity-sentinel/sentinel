// client response.

import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { DeadlineV1 } from "./http.ts";
import type { HttpResponseV1 } from "./http.ts";
import type {
  IssueSourceErrorContextV1,
  PortErrorV1,
  PortResultV1,
  SkippedIssueV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { type ParseIssue, tryParse } from "../contracts/validation.ts";
import type { RawSendResult } from "./client-contracts.ts";

export function repoPath(repository: RepositoryIdentityV1): string {
  return `${repository.owner}/${repository.name}`;
}

/**
 * Combine one request-local deadline with an optional shared parent bound.
 * Expiry of either bound stops the operation; the shared parent is never
 * disposed by a request that borrowed it.
 */
export function combineDeadline(
  own: DeadlineV1,
  parent?: DeadlineV1,
): DeadlineV1 {
  if (parent === undefined) return own;
  return {
    race<T>(promise: Promise<T>): Promise<T> {
      return parent.race(own.race(promise));
    },
    fired(): boolean {
      return own.fired() || parent.fired();
    },
    dispose(): void {
      own.dispose();
    },
  };
}

/** Sanitized static transport-boundary failure (no status/body/URL echoed). */
export function unavailable(): RawSendResult {
  return {
    status: "error",
    error: { kind: "unavailable", detail: "GitHub API request failed" },
  };
}

export function parseWire<T>(
  response: HttpResponseV1,
  parser: (value: unknown) => T,
  source?: IssueSourceErrorContextV1,
): PortResultV1<T> {
  let body: unknown;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    return portError(
      "invalid",
      "GitHub API response is malformed",
      undefined,
      source === undefined
        ? undefined
        : { ...source, stage: "json", code: "malformed_json" },
    );
  }
  return parseWith(body, parser, source);
}

/**
 * One strict wire value. A contract-bound overflow (> max text) is
 * unavailable/incomplete — never a truncated value and never a malformed
 * shape; any other violation is invalid (fail closed).
 */
export function parseWith<T>(
  value: unknown,
  parser: (value: unknown) => T,
  source?: IssueSourceErrorContextV1,
): PortResultV1<T> {
  const parsed = tryParse(parser, value);
  if (!parsed.ok) {
    const issueSource = source === undefined
      ? undefined
      : issueValidationContext(source, parsed.issues[0]);
    if (parsed.issues.some((issue) => issue.code === "bound_exceeded")) {
      return portError(
        "unavailable",
        "GitHub API response exceeds contract bounds",
        undefined,
        issueSource,
      );
    }
    return portError(
      "invalid",
      "GitHub API response is malformed",
      undefined,
      issueSource,
    );
  }
  return portOk(parsed.value);
}

/** Rebuild only the closed issue-source fields, including at log boundaries. */
export function sanitizeIssueSourceContext(
  input: unknown,
): IssueSourceErrorContextV1 | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return;
  }
  const obj = input as Record<string, unknown>;
  if (
    typeof obj.target !== "string" ||
    !/^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(obj.target) ||
    obj.method !== "GET" || typeof obj.endpointPath !== "string" ||
    !(obj.endpointPath === `/repos/${obj.target}/issues` ||
      (obj.endpointPath.startsWith(`/repos/${obj.target}/issues/`) &&
        /^[1-9]\d{0,14}$/.test(
          obj.endpointPath.slice(`/repos/${obj.target}/issues/`.length),
        ))) ||
    !(obj.httpStatus === null || (typeof obj.httpStatus === "number" &&
      Number.isInteger(obj.httpStatus) && obj.httpStatus >= 100 &&
      obj.httpStatus <= 599)) ||
    !positiveCount(obj.page) ||
    typeof obj.stage !== "string" ||
    !["request", "http", "json", "validation", "pagination"].includes(
      obj.stage,
    ) ||
    typeof obj.code !== "string" ||
    !/^(?:unavailable|auth_failed|rate_limited|not_found|conflict|invalid|http_error|malformed_json|pagination_cycle|page_limit|item_limit|unknown_key|missing_field|wrong_type|invalid_enum|invalid_version|invalid_sha|invalid_digest|invalid_pattern|bound_exceeded|invalid_number|invalid_timestamp|invalid_count|invalid_boolean|invalid_nullability|invalid_base64|invalid_lifecycle|invalid_array|invalid_value)$/
      .test(obj.code)
  ) return;
  const context: IssueSourceErrorContextV1 = {
    target: obj.target,
    method: "GET",
    endpointPath: obj.endpointPath,
    httpStatus: obj.httpStatus as number | null,
    page: obj.page as number,
    stage: obj.stage as IssueSourceErrorContextV1["stage"],
    code: obj.code as IssueSourceErrorContextV1["code"],
  };
  if (
    typeof obj.validationPath === "string" && obj.validationPath.length <= 96 &&
    /^\$(?:(?:\[\d{1,7}\])|(?:\.(?:number|title|body|state|user|login|labels|name|created_at|updated_at|closed_at)))*$/
      .test(obj.validationPath)
  ) {
    context.validationPath = obj.validationPath;
  }
  for (const key of ["limit", "observedLength", "issueNumber"] as const) {
    if (
      typeof obj[key] === "number" && Number.isSafeInteger(obj[key]) &&
      obj[key] >= 0
    ) context[key] = obj[key];
  }
  return context;
}

/** Rebuild a skipped issue from the same field allowlist used for failures. */
export function sanitizeSkippedIssue(
  value: unknown,
  repository: string,
): SkippedIssueV1 | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const context = sanitizeIssueSourceContext({
    target: repository,
    method: "GET",
    endpointPath: `/repos/${repository}/issues`,
    httpStatus: 200,
    page: 1,
    stage: "validation",
    code: row.code,
    validationPath: row.validationPath,
    limit: row.limit,
    observedLength: row.observedLength,
  });
  if (
    !positiveCount(row.number) || context?.code !== "bound_exceeded" ||
    context.validationPath === undefined ||
    !(row.limit === null || context.limit !== undefined) ||
    !(row.observedLength === null || context.observedLength !== undefined)
  ) return null;
  return {
    number: row.number as number,
    code: "bound_exceeded",
    validationPath: context.validationPath,
    limit: context.limit ?? null,
    observedLength: context.observedLength ?? null,
  };
}

function positiveCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Bounded child-outcome string; arbitrary port detail is never copied. */
export function issueSourceFailureDetail(error: PortErrorV1): string {
  const source = sanitizeIssueSourceContext(error.issueSource);
  const prefix = `issue source unavailable: ${error.kind}`;
  if (source === undefined) return prefix;
  return `${prefix}; ${source.method} ${source.endpointPath} HTTP ${
    source.httpStatus ?? "none"
  } page ${source.page} ${source.stage}:${source.code}${
    source.issueNumber === undefined ? "" : ` issue #${source.issueNumber}`
  }${source.limit === undefined ? "" : ` limit=${source.limit}`}${
    source.observedLength === undefined
      ? ""
      : ` length=${source.observedLength}`
  }${source.validationPath === undefined ? "" : ` at ${source.validationPath}`}`
    .slice(0, 300);
}

/** Only numeric measurements from our validator's static message are retained. */
export function issueValidationContext(
  source: IssueSourceErrorContextV1,
  issue: ParseIssue,
): IssueSourceErrorContextV1 | undefined {
  const measurement =
    /^(?:string of (\d+) chars|array of (\d+) items) exceeds (\d+)$/.exec(
      issue.message,
    );
  return sanitizeIssueSourceContext({
    ...source,
    stage: "validation",
    code: issue.code,
    validationPath: issue.path,
    ...(measurement === null ? {} : {
      observedLength: Number(measurement[1] ?? measurement[2]),
      limit: Number(measurement[3]),
    }),
  });
}

export function sameOrigin(first: string, second: string): boolean {
  try {
    return new URL(first).origin === new URL(second).origin;
  } catch {
    return false;
  }
}

export function nextLinkUrl(headers: Headers): string | null {
  const link = headers.get("link");
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match !== null) return match[1];
  }
  return null;
}
