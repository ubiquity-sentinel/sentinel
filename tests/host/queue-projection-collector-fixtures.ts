/** Synthetic HTTP only. These captures never authorize production pins. */
import { CanaryGitHub } from "../../ops/queue-canary-github.ts";
import { CANARY_REPOSITORY } from "../../ops/queue-canary-pins.ts";
import { runQueueCanary } from "../../ops/queue-canary.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { ACTOR, rig } from "./queue-canary-fixtures.ts";
import {
  detail,
  inventoryRow,
  NOW,
  ROOT,
} from "./queue-rules-projection-fixtures.ts";

export async function collectorRig(options: {
  branch?: "queue-canary" | "development";
  active?: boolean;
  phase?: number;
  both?: boolean;
  frozenClock?: boolean;
  mutate?: (
    response: HttpResponseV1,
    request: HttpRequestV1,
    count: number,
  ) => void;
} = {}) {
  const r = await rig();
  r.host.action = "preflight";
  const branch = options.branch ?? "queue-canary";
  const selected = detail(branch, options.active ?? false);
  const other = detail(
    branch === "development" ? "queue-canary" : "development",
    branch === "development",
  );
  const rulesets = options.both ? [selected, other] : [selected];
  Object.assign(r.grants[0], {
    projectionTargets: [{ branch, stagedRulesetId: selected.id }],
  });
  let now = NOW + (options.phase ?? 0) * 100_000;
  const requests: HttpRequestV1[] = [], bodies: string[] = [];
  const native = new CanaryGitHub({
    repository: CANARY_REPOSITORY,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock: { now: () => now },
    http: (request) => {
      assertGet(request);
      requests.push(request);
      if (!options.frozenClock) now += 1000;
      const url = new URL(request.url);
      let body: unknown;
      if (url.pathname === "/installation/repositories") {
        body = {
          total_count: 1,
          repositories: [{ id: 222, full_name: "ubiquity/ai.ubq.fi" }],
        };
      } else if (url.pathname === "/users/ubiquity-sentinel%5Bbot%5D") {
        body = { node_id: ACTOR.nodeId, login: ACTOR.login, type: "Bot" };
      } else if (url.pathname === `${ROOT}/rulesets`) {
        body = rulesets.map(inventoryRow);
      } else if (url.pathname.startsWith(`${ROOT}/rulesets/`)) {
        body = rulesets.find((row) =>
          String(row.id) === url.pathname.split("/").at(-1)
        );
        if (!body) throw new Error("unexpected ruleset ID");
      } else if (url.pathname.startsWith(`${ROOT}/rules/branches/`)) {
        const row = rulesets.find((row) =>
          row.conditions.ref_name.include[0] ===
            `refs/heads/${url.pathname.split("/").at(-1)}`
        );
        if (!row) throw new Error("unexpected branch");
        body = row.enforcement === "disabled" ? [] : row.rules.map((rule) => ({
          ...rule,
          ruleset_source_type: row.source_type,
          ruleset_source: row.source,
          ruleset_id: row.id,
        }));
      } else throw new Error("unexpected API");
      const response: HttpResponseV1 = {
        status: 200,
        headers: new Headers({
          date: new Date(now).toUTCString(),
          "x-github-request-id": `SYNTHETIC-${
            options.phase ?? 0
          }-${requests.length}`,
          "x-github-api-version-selected": "2022-11-28",
          etag: '"synthetic-etag"',
          "set-cookie": "synthetic-private-cookie",
          authorization: "synthetic-private-header",
        }),
        bodyText: JSON.stringify(body, null, 2),
      };
      options.mutate?.(response, request, requests.length);
      bodies.push(response.bodyText);
      if (request.responseType === "bytes") {
        response.bodyBytes ??= new TextEncoder().encode(response.bodyText);
        response.bodyText = "";
      }
      return Promise.resolve(response);
    },
  }, "synthetic-host-token");
  return {
    ...r,
    port: native,
    requests,
    bodies,
    rulesets,
    now: () => now,
    run: () => runQueueCanary({ ...r, port: native, now: () => now }),
  };
}
function assertGet(request: HttpRequestV1) {
  if (
    request.method !== "GET" || request.body !== null ||
    !request.url.startsWith("https://api.github.com/")
  ) {
    throw new Error("unexpected effect");
  }
}
