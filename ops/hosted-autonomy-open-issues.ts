/**
 * Complete open-issue numbers of one repository for the repair-tier step
 * (#324). Pull requests are skipped. Any failed, malformed or over-bound page
 * makes the whole listing unavailable: a prefix is never returned, because
 * the tier step treats a listed repository's missing issue as closed.
 */

import type { PortResultV1 } from "../src/contracts/ports.ts";
import { portError, portOk } from "../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  createHostedAutonomyRequest,
  LISTING_PAGE_SIZE,
  MAX_LISTING_PAGES,
} from "./hosted-autonomy-github-listing.ts";

/** Issue pages carry full bodies; the per-page byte bound is wider. */
const OPEN_ISSUE_PAGE_BYTES = 8 * 1_048_576;

export type HostedRequestV1 = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
  maxBytes?: number,
) => Promise<unknown | null>;

export async function listHostedOpenIssueNumbers(
  request: HostedRequestV1,
  repository: RepositoryIdentityV1,
): Promise<PortResultV1<readonly number[]>> {
  const numbers: number[] = [];
  const scope = `${encodeURIComponent(repository.owner)}/${
    encodeURIComponent(repository.name)
  }`;
  for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
    const body = await request(
      "GET",
      `/repos/${scope}/issues?state=open&per_page=${LISTING_PAGE_SIZE}` +
        `&page=${page}`,
      undefined,
      OPEN_ISSUE_PAGE_BYTES,
    );
    if (!Array.isArray(body)) {
      return portError("unavailable", "open issue listing unavailable");
    }
    for (const item of body) {
      if (item === null || typeof item !== "object") {
        return portError("invalid", "open issue listing is malformed");
      }
      const row = item as Record<string, unknown>;
      if (!Number.isSafeInteger(row.number) || (row.number as number) < 1) {
        return portError("invalid", "open issue listing is malformed");
      }
      if (Object.hasOwn(row, "pull_request")) continue;
      if (row.state !== "open") continue;
      numbers.push(row.number as number);
    }
    if (body.length < LISTING_PAGE_SIZE) return portOk(numbers);
  }
  return portError("unavailable", "open issue listing exceeds its page bound");
}

/** Production lister: the self repository uses the self token. */
export function createHostedOpenIssueLister(
  tokenFor: (repository: RepositoryIdentityV1) => string,
): (repository: RepositoryIdentityV1) => Promise<
  PortResultV1<readonly number[]>
> {
  return (repository) =>
    listHostedOpenIssueNumbers(
      createHostedAutonomyRequest(tokenFor(repository)),
      repository,
    );
}
