/**
 * A listed target the tolerant App-token mint dropped from the run's token is
 * excluded for the run even when it is public (`target-token-scope.ts`): the
 * runtime never configures, reads or plans it, and the launcher gate hides it.
 */
import { PUBLIC_CONTROLLER_PROFILE } from "../../src/contracts/hosted-controller-deployment.ts";
import assert from "node:assert/strict";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import { runActionsRepairHost } from "../../src/host/actions-repair-host.ts";
import {
  grantTokenScopeV1,
  reportedTokenScopeV1,
  scopedVisibilityReaderV1,
  tokenScopeLineV1,
} from "../../src/host/target-token-scope.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { createPrivateTargetGateV1 } from "../../ops/hosted-autonomy-private-targets.ts";
import { rig } from "./matrix-actions-fixtures.ts";
import {
  advanceWithLog,
  LISTED,
  NO_MODEL,
  observed,
  PRODUCTION,
  QUIET_LOG,
  quietly,
  reply,
  servingJobLogs,
} from "./targets-deferral-fixtures.ts";

const INSTALLATION = 155687488;
const NOW = Date.parse("2026-11-22T12:00:00Z");

function grant(names: readonly string[] | undefined): string {
  return JSON.stringify({
    version: 1,
    appId: 4682172,
    installationId: INSTALLATION,
    appSlug: "ubiquity-sentinel",
    expiresAt: "2099-01-01T00:00:00Z",
    permissions: { contents: "write", metadata: "read" },
    ...(names === undefined ? {} : { repositoryNames: [...names] }),
  });
}

Deno.test("token scope: only a same-mint grant's names decide; self is never excluded", () => {
  const outside = grantTokenScopeV1(grant(["AI.ubq.fi"]), NOW, INSTALLATION);
  assert.ok(outside !== null);
  assert.equal(outside("ubiquity/ai.ubq.fi"), false);
  assert.equal(outside("ubiquity/prospector"), true);
  assert.equal(outside("ubiquity-sentinel/sentinel"), false);
  // No evidence excludes nothing: today's behaviour.
  for (
    const text of [undefined, null, "", "{", grant(undefined)]
  ) assert.equal(grantTokenScopeV1(text, NOW, INSTALLATION), null);
  assert.equal(grantTokenScopeV1(grant(["x"]), NOW, 7), null);
  const listed = ["ubiquity-sentinel/sentinel", "ubiquity/prospector"];
  assert.deepEqual(
    reportedTokenScopeV1(
      listed,
      "Ubiquity/Prospector,ubiquity-sentinel/sentinel,other/x",
    ),
    ["ubiquity/prospector"],
  );
  assert.deepEqual(reportedTokenScopeV1(listed, null), []);
  assert.deepEqual(reportedTokenScopeV1(listed, "x".repeat(20_000)), []);
  assert.equal(tokenScopeLineV1([]), null);
  assert.deepEqual(tokenScopeLineV1(["ubiquity/prospector"]), {
    kind: "sentinel_target_token_scope",
    reason: "token_scope",
    count: 1,
    targets: ["ubiquity/prospector"],
  });
});

const PUBLIC = (branch: string) =>
  reply(
    200,
    {},
    `{"default_branch":"${branch}","private":false,"visibility":"public"}`,
  );

/** Both listed targets are public and readable with any token. */
function publicTargets(http: HttpTransportV1): HttpTransportV1 {
  return (request) => {
    const path = new URL(request.url).pathname;
    if (
      request.method === "GET" && path === "/repos/ubiquity-sentinel/sentinel"
    ) {
      return PUBLIC("development")();
    }
    if (request.method === "GET" && path === "/repos/ubiquity/prospector") {
      return PUBLIC("main")();
    }
    return http(request);
  };
}

class CyclesReached extends Error {}

async function repairPass(mintGrant: string | undefined) {
  const r = await rig();
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    await advanceWithLog(r, 72, QUIET_LOG, 101);
    const deps = await r.job("token-scope-serial", "repair");
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, LISTED);
    const http = observed(
      publicTargets(servingJobLogs(deps.http, new Map([[101, QUIET_LOG]]))),
    );
    const before = await r.store.readRepair();
    const configured: string[][] = [];
    const { value: outcome, lines } = await quietly(async () => {
      try {
        await runActionsRepairHost({
          ...deps,
          ...PRODUCTION,
          env: {
            ...deps.env,
            ...(mintGrant === undefined
              ? {}
              : { SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: mintGrant }),
          },
          state: r.store,
          http: http.http,
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
    const after = await r.store.readRepair();
    return {
      outcome,
      lines,
      configured,
      requests: http.requests,
      before,
      after,
    };
  } finally {
    await r.cleanup();
  }
}

Deno.test("token scope (runtime): a public target outside the minted token is never read, configured or planned", async () => {
  const run = await repairPass(grant(["ai.ubq.fi"]));
  assert.equal(run.outcome, "cycles", "Sentinel's own target still runs");
  assert.deepEqual(run.configured, [["ubiquity-sentinel/sentinel"]]);
  assert.deepEqual(
    run.requests.filter((request) => request.includes("prospector")),
    [],
    "not even its repository read",
  );
  const scope = run.lines.filter((line) =>
    line.includes("sentinel_target_token_scope")
  );
  assert.deepEqual(scope.map((line) => JSON.parse(line)), [{
    kind: "sentinel_target_token_scope",
    reason: "token_scope",
    count: 1,
    targets: ["ubiquity/prospector"],
  }]);
  // No model start and no state write before the (stopped) cycles.
  assert.deepEqual(run.after, run.before);
});

Deno.test("token scope (runtime): without grant names, or with it covered, the same pass reads the public target as today", async () => {
  for (
    const mintGrant of [
      undefined,
      grant(undefined),
      grant(["ai.ubq.fi", "Prospector"]),
    ]
  ) {
    const run = await repairPass(mintGrant);
    assert.equal(run.outcome, "cycles");
    // Today's load: its repository read happens (its tree facts then decide).
    assert.ok(
      run.requests.includes("GET /repos/ubiquity/prospector"),
      String(mintGrant),
    );
    assert.equal(
      run.lines.some((line) => line.includes("sentinel_target_token_scope")),
      false,
    );
  }
});

Deno.test("token scope (launcher gate): a reported public target is hidden without a read; the rest are read", async () => {
  const reads: string[] = [];
  const listed = [
    "ubiquity-sentinel/sentinel",
    "ubiquity/prospector",
    "ubiquity/ai.ubq.fi",
  ];
  const gate = createPrivateTargetGateV1({
    profile: PUBLIC_CONTROLLER_PROFILE,
    readVisibility: scopedVisibilityReaderV1(
      (repository: { owner: string; name: string }) => {
        reads.push(`${repository.owner}/${repository.name}`);
        return Promise.resolve("public" as const);
      },
      reportedTokenScopeV1(listed, "ubiquity/prospector"),
    ),
  });
  const repository = (name: string) => ({
    owner: "ubiquity",
    name,
    installationId: INSTALLATION,
  });
  assert.equal(await gate.workable(repository("prospector")), false);
  assert.equal(await gate.workable(repository("ai.ubq.fi")), true);
  assert.deepEqual(reads, ["ubiquity/ai.ubq.fi"]);
});
