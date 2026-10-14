// Shared scripted-port setup; this helper registers no tests.
import { portOk } from "../../src/contracts/ports.ts";
import type { DenoAuthProviderV1 } from "../../src/release/http.ts";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import {
  asTransport,
  REVISIONS_PATH,
  type ScriptedTransport,
  T0,
  TestClock,
} from "./helpers.ts";

export function client(
  transport: ScriptedTransport,
  clock = new TestClock(T0),
) {
  const auth: DenoAuthProviderV1 = {
    bearerToken: () => Promise.resolve(portOk("deno-token")),
  };
  return new DenoReleaseRESTClient({
    transport: asTransport(transport),
    auth,
    config: transport.config,
    clock,
  });
}

export function noAuth(): DenoAuthProviderV1 {
  return {
    bearerToken: () =>
      Promise.resolve({
        ok: false as const,
        error: { kind: "auth_failed" as const, detail: "x" },
      }),
  };
}

/** One full succeeded page of `pageSize` unrelated revision entries. */
export function unrelatedPage(start: number, pageSize: number): unknown[] {
  return Array.from({ length: pageSize }, (_, index) => ({
    id: `dep-${start + index}`,
    status: "succeeded",
    labels: { "custom.branch": "main" },
    created_at: "2026-09-07T00:00:00.000Z",
  }));
}

/** Registers a page-aware revisions list (records cursor queries). */
export function paginatedListRoute(
  transport: ScriptedTransport,
  pages: {
    entries: unknown[];
    /** Exact Link header value returned with this page, or null. */
    link: string | null;
    /** The cursor that requests this page (null = first page). */
    cursorLabel?: string | null;
  }[],
): void {
  transport.route({
    method: "GET",
    pathname: REVISIONS_PATH,
    respond: (url) => {
      if (url.searchParams.get("status") !== "succeeded") {
        return { kind: "reject" };
      }
      const cursor = url.searchParams.get("cursor") ?? null;
      const index = cursor === null
        ? 0
        : pages.findIndex((page) => page.cursorLabel === cursor);
      if (index < 0) {
        throw new Error(`unexpected cursor request: ${cursor}`);
      }
      const page = pages[index];
      const headers: Record<string, string> = {};
      if (page.link !== null) headers["link"] = page.link;
      return {
        kind: "response",
        status: 200,
        headers,
        body: JSON.stringify(page.entries),
      };
    },
  });
}
