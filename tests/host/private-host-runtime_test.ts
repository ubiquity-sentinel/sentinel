import assert from "node:assert/strict";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import { runActionsRepairHost } from "../../src/host/actions-repair-host.ts";
import { HOSTED_RUNTIME_STATIC_IDENTITY } from "../../src/host/hosted-runtime-identity.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { PRIVATE_TARGET_REASON } from "../../src/repair/target-visibility.ts";
import { PRIVATE_TARGETS_KIND } from "../../src/repair/private-targets-line.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
import { rig } from "./matrix-actions-fixtures.ts";
import {
  advanceWithLog,
  NO_MODEL,
  QUIET_LOG,
  quietly,
  reply,
  servingJobLogs,
} from "./targets-deferral-fixtures.ts";

const QUIET = new Map([[101, QUIET_LOG]]);
const SETTING = JSON.stringify([
  "ubiquity/prospector",
  "ubiquity/ai.ubq.fi",
  "ubiquity/unstated",
]);
const BODY = {
  private: '{"default_branch":"main","private":true,"visibility":"private"}',
  public: '{"default_branch":"main","private":false,"visibility":"public"}',
  unstated: '{"default_branch":"main"}',
};

/** Repository reads by path; every other request reaches `http`. */
function github(
  http: HttpTransportV1,
  host: string,
  requests: string[],
): HttpTransportV1 {
  const bodies: Record<string, string> = {
    "/repos/ubiquity-sentinel/sentinel": host,
    "/repos/ubiquity/prospector": BODY.private,
    "/repos/ubiquity/ai.ubq.fi": BODY.public,
    "/repos/ubiquity/unstated": BODY.unstated,
  };
  return (request) => {
    const path = new URL(request.url).pathname;
    const body = request.method === "GET" ? bodies[path] : undefined;
    if (body === undefined) return http(request);
    requests.push(`${path} ${request.headers.get("authorization")}`);
    return reply(200, {}, body)();
  };
}

class CyclesReached extends Error {}

async function pass(host: string, name: string) {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    await advanceWithLog(r, 72, QUIET_LOG, 101);
    const deps = await r.job(name, "repair");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, SETTING);
    const requests: string[] = [];
    const configured: string[][] = [];
    const { value: outcome, lines } = await quietly(async () => {
      try {
        await runActionsRepairHost({
          ...deps,
          // The production repository resolver over the fake GitHub; the
          // rig's tree facts stand in for the generic targets' contents.
          resolveRepository: undefined,
          state: r.store,
          http: github(servingJobLogs(deps.http, QUIET), host, requests),
          model: NO_MODEL,
          preflight: () => Promise.resolve(),
          runTargetCycles: (input) => {
            configured.push(
              input.configs.map((config) =>
                `${config.repository.owner}/${config.repository.name}`
              ),
            );
            throw new CyclesReached();
          },
        });
        return "returned";
      } catch (error) {
        return error instanceof CyclesReached ? "cycles" : String(error);
      }
    });
    const line = scanStepLines(lines.join("\n"));
    return { outcome, configured, requests, line };
  } finally {
    await r.cleanup();
  }
}

Deno.test("the committed public controller refuses a private host answer before foreign reads or repair", async () => {
  const run = await pass(BODY.private, "public-host-mismatch");
  assert.match(run.outcome, /deployment_visibility_mismatch/);
  assert.deepEqual(run.configured, []);
  assert.deepEqual(run.requests, [
    "/repos/ubiquity-sentinel/sentinel Bearer fake-read-token",
  ]);
  assert.deepEqual(
    run.line.filter((entry) => entry.kind === "sentinel_deployment_refused"),
    [{
      kind: "sentinel_deployment_refused",
      reason: "deployment_visibility_mismatch",
      repository: "ubiquity-sentinel/sentinel",
      expected: "public",
      observed: "private",
    }],
  );
});

Deno.test("private host: a host GitHub answers is public, or does not say, works exactly the public-only set", async () => {
  for (const host of [BODY.public, BODY.unstated, "not json"]) {
    const run = await pass(host, `public-host-runtime-${host.length}`);
    assert.equal(run.outcome, "cycles", host);
    assert.deepEqual(run.configured, [["ubiquity/ai.ubq.fi"]], host);
    assert.deepEqual(
      run.line.filter((entry) => entry.kind === PRIVATE_TARGETS_KIND),
      [{
        kind: PRIVATE_TARGETS_KIND,
        reason: PRIVATE_TARGET_REASON,
        skipped: 1,
        listed: 3,
        configured: 1,
      }],
      host,
    );
  }
});

Deno.test("private host: no environment can name another host repository", async () => {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const deps = await r.job("private-host-spoof", "repair");
    for (
      const repository of [
        "ubiquity/prospector",
        "ubiquity-sentinel-private/sentinel",
      ]
    ) {
      let requests = 0;
      await assert.rejects(
        runActionsRepairHost({
          ...deps,
          env: { ...deps.env, GITHUB_REPOSITORY: repository },
          state: r.store,
          http: () => {
            requests++;
            return reply(200, {}, BODY.private)();
          },
          model: NO_MODEL,
        }),
        new RegExp(HOSTED_RUNTIME_STATIC_IDENTITY),
      );
      assert.equal(requests, 0, repository);
    }
  } finally {
    await r.cleanup();
  }
});
