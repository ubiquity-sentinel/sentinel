export const API_BASE = "https://api.github.com";
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 1_048_576;
/**
 * Compare responses embed the whole commit and file gap between two revisions,
 * so they legitimately exceed the ordinary bound: the 2026-10-05 stacked
 * merges compared against a five-day-advanced branch at ~1.9 MB, and the
 * rejected read silently read as "not integrated". The bound stays finite: a
 * compare that cannot fit is still refused.
 */
export const MAX_COMPARE_RESPONSE_BYTES = 8 * 1_048_576;
/**
 * GitHub list pagination bound. Every list read that gates a delivery must be
 * COMPLETE: the reader walks pages until the response's own `total_count` is
 * covered, and a listing that promises more items than the bound can cover is
 * refused rather than answered from a prefix.
 */
export const LISTING_PAGE_SIZE = 100;
/** The workflow-run listing keeps its pre-existing 50-item page size. */
export const RUN_LISTING_PAGE_SIZE = 50;
export const MAX_LISTING_PAGES = 20;

/** Bounded request capability shared by one repository's list and object readers. */
export function createHostedAutonomyRequest(token: string) {
  async function request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    maxBytes: number = MAX_RESPONSE_BYTES,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "sentinel-hosted-autonomy",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) return null;
      const text = await response.text();
      if (text.length > maxBytes) return null;
      return JSON.parse(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return request;
}

/**
 * Bounded effect request whose only evidence is GitHub's own acceptance: true
 * for any 2xx answer, whatever its body. The re-run endpoints answer 201 with
 * an empty body, which the JSON reader above reads as a refusal; the body here
 * is never parsed or returned, and a timeout or network error is false.
 */
export function createHostedAutonomyEffect(token: string) {
  return async function effect(method: string, path: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "sentinel-hosted-autonomy",
        },
        signal: controller.signal,
      });
      await response.body?.cancel();
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Complete listing read for ONE GitHub list endpoint. Every page is read
 * until the response's own `total_count` is covered, and the read is refused
 * (null) whenever it cannot be proven complete and consistent:
 *
 *  - a page without a valid `total_count` or list field is malformed;
 *  - a `total_count` that changes between pages is count drift;
 *  - an item without a usable id, or the same id twice, is a duplicate read;
 *  - an empty page while more items are promised, or a page bound that the
 *    promised count cannot fit, is an incomplete read.
 *
 * Callers fail closed on null: an unproven listing is never green and never
 * authorizes an approval.
 */
export async function readHostedCompleteListing(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  pagePath: (page: number) => string,
  key: string,
  pageSize: number,
): Promise<Record<string, unknown>[] | null> {
  const items: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  let total: number | null = null;
  for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
    const body = await request("GET", pagePath(page));
    if (body === null || typeof body !== "object") return null;
    const obj = body as Record<string, unknown>;
    const count = obj["total_count"];
    if (
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0
    ) {
      return null;
    }
    if (total === null) {
      total = count;
      if (total > MAX_LISTING_PAGES * pageSize) return null;
    } else if (total !== count) {
      // The endpoint's own count moved between pages: the listing is not one
      // stable read.
      return null;
    }
    const list = obj[key];
    if (!Array.isArray(list)) return null;
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const id = record["id"];
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
        return null;
      }
      if (seen.has(id)) return null;
      seen.add(id);
      items.push(record);
    }
    if (items.length > total) return null;
    if (items.length === total) break;
    if (list.length === 0) return null;
  }
  if (total === null || items.length !== total) return null;
  return items;
}
