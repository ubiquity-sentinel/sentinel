/**
 * Maintenance holds two credentials: the `ubiquity` installation token for
 * the foreign targets and the self token for `ubiquity-sentinel/sentinel`.
 * The current-matrix recovery adapters must bind each target's candidate
 * port, mirror refresh and default-branch read to the credential that can
 * actually reach that repository; the foreign token cannot read or push the
 * self repository, which left every self matrix candidate unpreserved.
 */
import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import { DEFAULT_APP_INSTALLATION_ID } from "../../src/host/actions-target-cycles.ts";
import { HOSTED_CONTROLLER_SELF } from "../../src/contracts/hosted-controller-deployment.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import {
  createHostedClosedMatrixRecovery,
  maintenanceTargetToken,
} from "../../ops/hosted-autonomy-matrix-adapters.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import { snapshot } from "./actions-candidates-fixture.ts";

// CI shards read only the repository root: temp fixtures live under it, like
// the other credential-free hosted fixtures.
const ROOT = decodeURIComponent(new URL("../..", import.meta.url).pathname)
  .replace(/\/$/, "");

const SELF_TOKEN = "fixture-self-token";
const API_TOKEN = "fixture-ubiquity-token";
const FOREIGN = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: DEFAULT_APP_INSTALLATION_ID,
};
const RESERVATION = "b".repeat(64);

async function inflightRecord(
  id: string,
  repository: typeof FOREIGN | typeof HOSTED_CONTROLLER_SELF,
) {
  const key = `impl:${RESERVATION}`;
  const branch = await candidatePreservationRef(
    repository,
    id as WorkItemId,
    key,
  );
  return {
    branch,
    record: workRecord(id, {
      repository,
      target: {
        base: SHA1,
        branch: `sentinel/repair/${id}`,
        checkpoint: null,
        head: SHA2,
        pr: null,
        candidateState: { preserved: null, publishedHead: null },
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      intent: {
        kind: "candidate_preservation",
        key,
        startedAt: T0,
        branch,
        expectedHead: SHA2,
        observedBase: SHA1,
        pr: null,
        requestId: RESERVATION,
        resultId: null,
      },
    }),
  };
}

Deno.test("maintenance target token: the self repository never falls back to the ubiquity installation token", () => {
  const tokens = { token: SELF_TOKEN, apiToken: API_TOKEN };
  assert.equal(
    maintenanceTargetToken(HOSTED_CONTROLLER_SELF, tokens),
    SELF_TOKEN,
  );
  assert.equal(maintenanceTargetToken(FOREIGN, tokens), API_TOKEN);
  // A self slug under a foreign installation scope is not the self scope.
  assert.equal(
    maintenanceTargetToken(
      {
        ...HOSTED_CONTROLLER_SELF,
        installationId: DEFAULT_APP_INSTALLATION_ID,
      },
      tokens,
    ),
    API_TOKEN,
  );
});

Deno.test("current-matrix recovery binds each target's candidate port and branch read to its own credential", async () => {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-matrix-tokens-",
    dir: ROOT,
  });
  try {
    await Deno.writeTextFile(
      `${tmp}/sentinel.targets.json`,
      JSON.stringify(["ubiquity-sentinel/sentinel", "ubiquity/ai.ubq.fi"]),
    );
    const self = await inflightRecord("issue-ubiquity-sentinel-179", {
      ...HOSTED_CONTROLLER_SELF,
    });
    const foreign = await inflightRecord("issue-ubiquity-ai.ubq.fi-9", FOREIGN);
    const state = new MemoryState();
    state.repair = snapshot([self.record, foreign.record]);
    const requests: { url: string; authorization: string | null }[] = [];
    const http = (request: HttpRequestV1) => {
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization") ?? null,
      });
      const path = new URL(request.url).pathname;
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: JSON.stringify({ default_branch: "development" }),
        });
      }
      if (path.includes("/git/ref/")) {
        return Promise.resolve({
          status: 404,
          headers: new Headers(),
          bodyText: JSON.stringify({ message: "Not Found" }),
        });
      }
      return Promise.reject(new Error(`unexpected request ${path}`));
    };
    const recovery = await createHostedClosedMatrixRecovery({
      state,
      clock: new FakeClock(T0 + 60_000),
      token: SELF_TOKEN,
      apiToken: API_TOKEN,
      sourceDir: tmp,
      scratch: `${tmp}/scratch`,
      artifactRoot: `${tmp}/artifacts`,
      cooldownMode: "off",
      http,
      artifactHttp: http,
    });
    const configFor = (owner: string) =>
      recovery.configs.find((config) => config.repository.owner === owner)!;
    const branchReads = requests.filter((row) =>
      /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(row.url)
    );
    assert.deepEqual(
      branchReads.map((
        row,
      ) => [row.url.split("/repos/")[1], row.authorization]),
      [
        ["ubiquity-sentinel/sentinel", `Bearer ${SELF_TOKEN}`],
        ["ubiquity/ai.ubq.fi", `Bearer ${API_TOKEN}`],
      ],
    );
    for (
      const [config, ref, token] of [
        [configFor("ubiquity-sentinel"), self.branch, SELF_TOKEN],
        [configFor("ubiquity"), foreign.branch, API_TOKEN],
      ] as const
    ) {
      requests.length = 0;
      const read = await recovery.cycleFor(config).github.readRef(ref);
      assert.ok(read.ok, JSON.stringify(read));
      assert.equal(read.value, null);
      assert.deepEqual(
        requests.map((row) => [
          row.url.split("/repos/")[1].split("/git/ref/")[0],
          row.authorization,
        ]),
        [[
          `${config.repository.owner}/${config.repository.name}`,
          `Bearer ${token}`,
        ]],
        JSON.stringify(requests),
      );
    }
    void (SHA1 as GitSha);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});
