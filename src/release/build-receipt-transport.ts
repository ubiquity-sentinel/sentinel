// Whole-resolution deadlines, cancellation and bounded authenticated/signed reads.
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import {
  API_ACCEPT,
  API_ORIGIN,
  API_VERSION,
  asNonNegInt,
  asRecord,
  BadPayload,
  ERR_AUTH,
  ERR_NOT_FOUND,
  ERR_PAYLOAD,
  ERR_RATE,
  ERR_STORAGE,
  ERR_TIMEOUT,
  ERR_TRANSPORT,
  field,
  MAX_JSON_BYTES,
  MAX_PAGES,
  MAX_TOTAL_ITEMS,
  PAGE_SIZE,
} from "./build-receipt-config.ts";

export const DEADLINE = Symbol("deadline");

export type Guarded<T> = T | typeof DEADLINE;

/**
 * Race a promise against a real-time deadline. The timer is always cleared
 * and a late rejection after the race settled is consumed, so an
 * uncooperative promise can never leak a timer or an unhandled rejection.
 */
export function guardUntil<T>(
  promise: Promise<T>,
  remainingMs: number,
): Promise<Guarded<T>> {
  const tracked = Promise.resolve(promise);
  if (remainingMs <= 0) {
    // The caller still owns the promise; consume its rejection even when the
    // deadline already expired, so a late failure is never unhandled.
    tracked.catch(() => {});
    return Promise.resolve(DEADLINE);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), remainingMs);
  });
  const outcome = Promise.race([tracked, timeout]) as Promise<Guarded<T>>;
  tracked.catch(() => {}); // consume a rejection that arrives after the race
  void outcome.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
  return outcome;
}

/** One whole-resolve real-time budget, from before auth through body+ZIP. */
export class DeadlineTracker {
  private readonly startedAt: number;

  constructor(private readonly budgetMs: number) {
    this.startedAt = Date.now();
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - (Date.now() - this.startedAt));
  }

  isExhausted(): boolean {
    return this.remainingMs() <= 0;
  }
}

/** Grace window for best-effort cleanup of uncooperative promises. */
export const CLEANUP_GRACE_MS = 500;

/**
 * Start best-effort cleanup without ever awaiting it. Cleanup is bounded by
 * a grace timer (unref'd so a pending cleanup never keeps the runtime alive)
 * and every rejection is consumed, so an uncooperative cancel can never hang
 * or leak an unhandled rejection.
 */
export function startCleanup(work: Promise<unknown>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), CLEANUP_GRACE_MS);
    const deno = (globalThis as {
      Deno?: { unrefTimer?: (id: ReturnType<typeof setTimeout>) => void };
    }).Deno;
    deno?.unrefTimer?.(timer);
  });
  const settled = Promise.race([Promise.resolve(work).catch(() => {}), grace]);
  void settled.then(() => clearTimeout(timer), () => clearTimeout(timer));
}

/** Tracks in-flight fetch controllers and body readers for cleanup. */
export class FetchContext {
  private readonly controllers: AbortController[] = [];
  private readonly readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();

  track(controller: AbortController): void {
    this.controllers.push(controller);
  }

  trackReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    this.readers.add(reader);
  }

  /** Best-effort bounded cancel of an unread response body; never awaited. */
  cancelBody(body: ReadableStream<Uint8Array> | null): void {
    if (body === null) return;
    startCleanup(Promise.resolve().then(() => body.cancel()));
  }

  /**
   * Best-effort bounded cancel of a tracked reader and release of its lock.
   * Every exit path of a bounded body read ends here, so a reader is never
   * left tracked or locked after this resolver stops waiting on it. The lock
   * is released immediately after cancel() is issued, never while awaiting
   * cancellation settlement, so an underlying cancel that never settles
   * cannot keep the stream locked.
   */
  cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    this.readers.delete(reader);
    try {
      startCleanup(Promise.resolve(reader.cancel()));
    } catch {
      // Cancel already ran or the reader was released; still unlock below.
    }
    try {
      reader.releaseLock();
    } catch {
      // Lock already released or a pending read still holds it.
    }
  }

  dispose(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.length = 0;
    for (const reader of this.readers) this.cancelReader(reader);
  }
}

// ---------------------------------------------------------------------------
// Strict fail-closed payload field readers. A malformed shape throws
// BadPayload; each step maps that to one static invalid error.
// ---------------------------------------------------------------------------

export function mapHttpStatus(status: number): PortResultV1<never> {
  if (status === 401 || status === 403) {
    return portError("auth_failed", ERR_AUTH);
  }
  if (status === 429) return portError("rate_limited", ERR_RATE);
  if (status === 404) return portError("not_found", ERR_NOT_FOUND);
  return portError("unavailable", ERR_TRANSPORT);
}

/** Bounded JSON body read: exactly 200, at most MAX_JSON_BYTES, fatal UTF-8. */
export async function readBoundedBytes(
  api: GithubApi,
  response: Response,
  cap: number,
  errorDetail: string,
): Promise<PortResultV1<Uint8Array>> {
  const body = response.body;
  if (body === null) return portError("invalid", errorDetail);
  const reader = body.getReader();
  api.ctx.trackReader(reader);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const guarded = await guardUntil(
        reader.read(),
        api.tracker.remainingMs(),
      );
      if (guarded === DEADLINE) {
        api.ctx.cancelReader(reader);
        return portError("unavailable", ERR_TIMEOUT);
      }
      const step = guarded;
      if (step.done) break;
      const chunk = step.value;
      if (chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (total > cap) {
        api.ctx.cancelReader(reader);
        return portError("invalid", errorDetail);
      }
      chunks.push(chunk);
    }
  } catch {
    api.ctx.cancelReader(reader);
    if (api.tracker.isExhausted()) return portError("unavailable", ERR_TIMEOUT);
    return portError("invalid", errorDetail);
  }
  api.ctx.cancelReader(reader); // stream done: release the lock, best-effort
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return portOk(output);
}

export class GithubApi {
  readonly ctx = new FetchContext();

  constructor(
    readonly fetchImpl: typeof globalThis.fetch,
    readonly tracker: DeadlineTracker,
    readonly authorization: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: this.authorization,
      accept: API_ACCEPT,
      "x-github-api-version": API_VERSION,
    };
  }

  /** Authenticated bounded GET against the fixed API origin; no redirect. */
  async get(
    pathname: string,
    params: Record<string, string> | null = null,
    manualRedirect = false,
  ): Promise<PortResultV1<Response>> {
    if (this.tracker.isExhausted()) {
      return portError("unavailable", ERR_TIMEOUT);
    }
    const url = new URL(`${API_ORIGIN}${pathname}`);
    if (params !== null) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const controller = new AbortController();
    this.ctx.track(controller);
    const fetchPromise = this.fetchImpl(url.href, {
      method: "GET",
      headers: this.headers(),
      signal: controller.signal,
      redirect: manualRedirect ? "manual" : "error",
    });
    try {
      const guarded = await guardUntil(
        fetchPromise,
        this.tracker.remainingMs(),
      );
      if (guarded === DEADLINE) {
        controller.abort();
        // The injected transport may ignore the signal; cancel any late body.
        void fetchPromise.then(
          (late) => this.ctx.cancelBody(late.body),
          () => {},
        );
        return portError("unavailable", ERR_TIMEOUT);
      }
      return portOk(guarded);
    } catch {
      if (this.tracker.isExhausted()) {
        return portError("unavailable", ERR_TIMEOUT);
      }
      return portError("unavailable", ERR_TRANSPORT);
    }
  }

  async getJson(
    pathname: string,
    params: Record<string, string> | null = null,
  ): Promise<PortResultV1<unknown>> {
    const response = await this.get(pathname, params);
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      this.ctx.cancelBody(response.value.body);
      return mapHttpStatus(response.value.status);
    }
    const bytes = await readBoundedBytes(
      this,
      response.value,
      MAX_JSON_BYTES,
      ERR_PAYLOAD,
    );
    if (!bytes.ok) return bytes;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.value);
    } catch {
      return portError("invalid", ERR_PAYLOAD);
    }
    try {
      return portOk(JSON.parse(text) as unknown);
    } catch {
      return portError("invalid", ERR_PAYLOAD);
    }
  }

  /** Credential-free signed storage GET: no auth, no redirect, no cookies. */
  async downloadSigned(location: URL): Promise<PortResultV1<Response>> {
    if (this.tracker.isExhausted()) {
      return portError("unavailable", ERR_TIMEOUT);
    }
    const controller = new AbortController();
    this.ctx.track(controller);
    const fetchPromise = this.fetchImpl(location.href, {
      method: "GET",
      headers: { accept: "application/octet-stream" },
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
    try {
      const guarded = await guardUntil(
        fetchPromise,
        this.tracker.remainingMs(),
      );
      if (guarded === DEADLINE) {
        controller.abort();
        void fetchPromise.then(
          (late) => this.ctx.cancelBody(late.body),
          () => {},
        );
        return portError("unavailable", ERR_TIMEOUT);
      }
      return portOk(guarded);
    } catch {
      if (this.tracker.isExhausted()) {
        return portError("unavailable", ERR_TIMEOUT);
      }
      return portError("unavailable", ERR_STORAGE);
    }
  }
}

/** Bounded complete pagination over locally built fixed page URLs. */
export interface PagedPayload {
  total: number;
  items: unknown[];
}

export async function paginate(
  api: GithubApi,
  pathname: string,
  params: Record<string, string>,
  itemsField: string,
  paginationDetail: string,
): Promise<PortResultV1<PagedPayload>> {
  let expectedTotal: number | null = null;
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageParams: Record<string, string> = {
      ...params,
      per_page: String(PAGE_SIZE),
      page: String(page),
    };
    const pageResult = await api.getJson(pathname, pageParams);
    if (!pageResult.ok) return pageResult;
    let total: number;
    let pageItems: unknown[];
    try {
      const root = asRecord(pageResult.value);
      total = asNonNegInt(field(root, "total_count"));
      const rawItems = field(root, itemsField);
      if (!Array.isArray(rawItems)) throw new BadPayload();
      pageItems = rawItems;
      if (pageItems.length > PAGE_SIZE) throw new BadPayload();
    } catch {
      return portError("invalid", paginationDetail);
    }
    if (total >= MAX_TOTAL_ITEMS) return portError("invalid", paginationDetail);
    if (expectedTotal === null) {
      expectedTotal = total;
    } else if (expectedTotal !== total) {
      return portError("invalid", paginationDetail);
    }
    items.push(...pageItems);
    if (items.length === expectedTotal) break;
    if (items.length > expectedTotal) {
      return portError("invalid", paginationDetail);
    }
    if (pageItems.length === 0) return portError("invalid", paginationDetail);
    if (page === MAX_PAGES) return portError("invalid", paginationDetail);
  }
  return portOk({ total: expectedTotal as number, items });
}

// ---------------------------------------------------------------------------
