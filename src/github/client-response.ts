// client response.

import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { DeadlineV1 } from "./http.ts";
import type { HttpResponseV1 } from "./http.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { tryParse } from "../contracts/validation.ts";
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
): PortResultV1<T> {
  let body: unknown;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    return portError("invalid", "GitHub API response is malformed");
  }
  return parseWith(body, parser);
}

/**
 * One strict wire value. A contract-bound overflow (> max text) is
 * unavailable/incomplete — never a truncated value and never a malformed
 * shape; any other violation is invalid (fail closed).
 */
export function parseWith<T>(
  value: unknown,
  parser: (value: unknown) => T,
): PortResultV1<T> {
  const parsed = tryParse(parser, value);
  if (!parsed.ok) {
    if (parsed.issues.some((issue) => issue.code === "bound_exceeded")) {
      return portError(
        "unavailable",
        "GitHub API response exceeds contract bounds",
      );
    }
    return portError("invalid", "GitHub API response is malformed");
  }
  return portOk(parsed.value);
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
