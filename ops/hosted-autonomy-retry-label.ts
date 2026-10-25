/**
 * Launcher-only `sentinel:retry` label capability for ONE target repository
 * (redesign 2026-10-25, C6), over the token the maintenance job already holds.
 * It lives on the launcher's port, never in `src/github`, so neither the
 * runtime nor a model worker ever holds it. Two endpoints only: the open
 * issues listing filtered by the label, and the one-label removal. Every
 * answer must name exactly this repository; anything unproven is null/false.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  API_BASE,
  type createHostedAutonomyRequest,
  LISTING_PAGE_SIZE,
  MAX_COMPARE_RESPONSE_BYTES,
} from "./hosted-autonomy-github-listing.ts";
import type { HostedRetryLabelV1 } from "./hosted-autonomy-types.ts";

/** The owner's re-admission label. GitHub label names are case-insensitive. */
export const SENTINEL_RETRY_LABEL = "sentinel:retry";

/** Listing pages read before the listing is refused as unbounded. */
export const RETRY_LABEL_LISTING_PAGES = 10;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The label names of one label array, or null when any entry is malformed. */
export function labelNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    const name = record(entry)?.["name"];
    if (typeof name !== "string") return null;
    names.push(name);
  }
  return names;
}

const isRetryLabel = (name: string) =>
  name.toLowerCase() === SENTINEL_RETRY_LABEL;

export function createHostedRetryLabel(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  repository: RepositoryIdentityV1,
): HostedRetryLabelV1 {
  const scope = `${repository.owner}/${repository.name}`;
  const repositoryUrl = `${API_BASE}/repos/${scope}`;
  const label = encodeURIComponent(SENTINEL_RETRY_LABEL);
  return {
    async listOpenRetryLabeled() {
      const numbers = new Set<number>();
      const seen = new Set<number>();
      for (let page = 1; page <= RETRY_LABEL_LISTING_PAGES; page++) {
        // Issue bodies make a page large; the compare bound keeps it finite.
        const raw = await request(
          "GET",
          `/repos/${scope}/issues?state=open&labels=${label}&per_page=${LISTING_PAGE_SIZE}&page=${page}`,
          undefined,
          MAX_COMPARE_RESPONSE_BYTES,
        );
        if (!Array.isArray(raw) || raw.length > LISTING_PAGE_SIZE) return null;
        for (const entry of raw) {
          const item = record(entry);
          const number = item?.["number"];
          const names = labelNames(item?.["labels"]);
          // A malformed item, a foreign repository, a repeat (the pages
          // shifted), a closed item or one without the label is not one
          // proven listing of this filter.
          if (
            item === null || typeof number !== "number" ||
            !Number.isSafeInteger(number) || number <= 0 ||
            item["repository_url"] !== repositoryUrl || seen.has(number) ||
            item["state"] !== "open" || names === null ||
            !names.some(isRetryLabel)
          ) return null;
          seen.add(number);
          // The issues listing also returns pull requests; they are skipped.
          if (item["pull_request"] !== undefined) continue;
          numbers.add(number);
        }
        if (raw.length < LISTING_PAGE_SIZE) return numbers;
      }
      return null;
    },
    async removeRetryLabel(number: number) {
      if (!Number.isSafeInteger(number) || number <= 0) return false;
      const raw = await request(
        "DELETE",
        `/repos/${scope}/issues/${number}/labels/${label}`,
      );
      const names = labelNames(raw);
      return names !== null && !names.some(isRetryLabel);
    },
  };
}
