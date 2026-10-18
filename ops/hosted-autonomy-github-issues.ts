/**
 * Launcher-only issue capability for review follow-ups in ONE target
 * repository, over the sentinel App token the maintenance job already holds.
 * It lives on the launcher's port, never in `src/github`, so neither the
 * runtime nor a model worker ever holds it. Only three endpoints are used:
 * the created-since issues listing, one issue read and one issue create.
 * Every answer must name exactly this repository; anything unproven is null.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "./hosted-autonomy-policy.ts";
import {
  API_BASE,
  type createHostedAutonomyRequest,
  LISTING_PAGE_SIZE,
  MAX_COMPARE_RESPONSE_BYTES,
} from "./hosted-autonomy-github-listing.ts";
import type {
  HostedFollowUpIssuesV1,
  HostedIssueListingItemV1,
  HostedIssueOriginV1,
} from "./hosted-autonomy-types.ts";

/** GitHub's `created_at` wire format: UTC, whole or fractional seconds. */
const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The first line of an issue body (LF or CRLF); null and absent are empty. */
export function issueFirstLine(body: unknown): string | null {
  if (body === null || body === undefined) return "";
  if (typeof body !== "string") return null;
  return body.split(/\r?\n/, 1)[0] ?? "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * One issue or pull request item bound to exactly `repositoryUrl`, or null
 * when any identity field is missing or malformed.
 */
export function parseIssueItem(
  raw: unknown,
  repositoryUrl: string,
): HostedIssueListingItemV1 | null {
  const item = record(raw);
  if (item === null) return null;
  const number = item["number"];
  const login = record(item["user"])?.["login"];
  const created = item["created_at"];
  const firstLine = issueFirstLine(item["body"]);
  if (
    typeof number !== "number" || !Number.isSafeInteger(number) ||
    number <= 0 || item["repository_url"] !== repositoryUrl ||
    typeof login !== "string" || login.length === 0 ||
    typeof created !== "string" || !CREATED_AT.test(created) ||
    firstLine === null
  ) return null;
  const createdAt = Date.parse(created);
  if (!Number.isSafeInteger(createdAt)) return null;
  return {
    number,
    author: login,
    createdAt,
    pullRequest: item["pull_request"] !== undefined &&
      item["pull_request"] !== null,
    firstLine,
  };
}

/** Pages are read at the ordinary 100-item size. */
export const FOLLOW_UP_LISTING_PAGE_SIZE = LISTING_PAGE_SIZE;

export function createHostedFollowUpIssues(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  repository: RepositoryIdentityV1,
): HostedFollowUpIssuesV1 {
  const scope = `${repository.owner}/${repository.name}`;
  const repositoryUrl = `${API_BASE}/repos/${scope}`;
  return {
    async listCreatedSince(input: { sinceMs: number; maxPages: number }) {
      if (
        !Number.isSafeInteger(input.sinceMs) ||
        !Number.isSafeInteger(input.maxPages) || input.maxPages < 1
      ) return null;
      const items: HostedIssueListingItemV1[] = [];
      const seen = new Set<number>();
      let previous = Number.POSITIVE_INFINITY;
      for (let page = 1; page <= input.maxPages; page++) {
        // Issue bodies make a page large; the compare bound keeps it finite.
        const raw = await request(
          "GET",
          `/repos/${scope}/issues?state=all&sort=created&direction=desc&per_page=${FOLLOW_UP_LISTING_PAGE_SIZE}&page=${page}`,
          undefined,
          MAX_COMPARE_RESPONSE_BYTES,
        );
        if (!Array.isArray(raw) || raw.length > FOLLOW_UP_LISTING_PAGE_SIZE) {
          return null;
        }
        for (const entry of raw) {
          const item = parseIssueItem(entry, repositoryUrl);
          // A malformed item, a repeat (the pages shifted under a new issue)
          // or an out-of-order creation instant is not one stable listing.
          if (
            item === null || seen.has(item.number) ||
            item.createdAt > previous
          ) return null;
          seen.add(item.number);
          previous = item.createdAt;
          items.push(item);
        }
        if (
          raw.length < FOLLOW_UP_LISTING_PAGE_SIZE || previous < input.sinceMs
        ) return items;
      }
      // The prefix is still proven down to its oldest item. The caller uses
      // that item as the horizon and refuses only candidates older than it.
      return items;
    },
    async readIssueOrigin(number: number): Promise<HostedIssueOriginV1 | null> {
      if (!Number.isSafeInteger(number) || number <= 0) return null;
      const raw = await request("GET", `/repos/${scope}/issues/${number}`);
      const item = parseIssueItem(raw, repositoryUrl);
      if (item === null || item.number !== number || item.pullRequest) {
        return null;
      }
      return { number, author: item.author, firstLine: item.firstLine };
    },
    async create(input: {
      title: string;
      body: string;
      labels?: readonly string[];
    }) {
      const raw = await request("POST", `/repos/${scope}/issues`, {
        title: input.title,
        body: input.body,
        ...(input.labels === undefined ? {} : { labels: input.labels }),
      });
      const item = parseIssueItem(raw, repositoryUrl);
      const created = record(raw);
      const labels = created?.["labels"];
      const returnedLabels = Array.isArray(labels)
        ? labels.flatMap((label) =>
          typeof label === "object" && label !== null &&
            typeof (label as Record<string, unknown>)["name"] === "string"
            ? [(label as Record<string, unknown>)["name"] as string]
            : []
        )
        : [];
      if (
        item === null || created === null || item.pullRequest ||
        item.author !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
        created["title"] !== input.title || created["body"] !== input.body ||
        (input.labels !== undefined &&
          input.labels.some((label) => !returnedLabels.includes(label)))
      ) return null;
      return item.number;
    },
  };
}
