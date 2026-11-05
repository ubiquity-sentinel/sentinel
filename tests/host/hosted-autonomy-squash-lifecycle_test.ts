/** #331: the launcher's reviewed self-delivery books a one-commit squash. */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  finding,
  HEAD,
  MERGE,
  SELF_REPO,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  readRequests,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

Deno.test("sentinel squash lifecycle: current-head delivery keeps one parent and reviewed identity", async (t) => {
  for (const movedBase of [false, true]) {
    await t.step(
      movedBase ? "off-tip squash refuses booking" : "single-commit delivery",
      async () => {
        const record = blockedRecord({
          blocker: {
            kind: "review_quota",
            message: "review rounds exhausted without an accepted verdict (P2)",
            since: 1,
          },
          counters: { attempts: 4, retries: 1, reviewRounds: 3 },
          target: {
            base: BASE,
            branch: "sentinel/repair/issue-ubiquity-sentinel-48",
            checkpoint: null,
            head: HEAD,
            pr: 51,
          },
        });
        const receipt = authorizingReceipt({
          findings: [finding("P2")],
          unresolvedSeverities: ["P2"],
        });
        const { rig, github } = await makeRig("autonomy-squash", {
          repair: repairSnapshot([record], [receipt]),
          defaultBranch: "development",
        });
        const original = globalThis.fetch;
        let merged = false;
        const writes: unknown[] = [];
        globalThis.fetch =
          ((input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            const scope = "/repos/ubiquity-sentinel/sentinel";
            if (init?.method === "PUT") {
              assert.equal(path, `${scope}/pulls/51/merge`);
              writes.push(JSON.parse(String(init.body)));
              merged = true;
              return Promise.resolve(
                Response.json({ merged: true, sha: MERGE }),
              );
            }
            if (path === scope) {
              return Promise.resolve(
                Response.json({ allow_squash_merge: true }),
              );
            }
            if (path === `${scope}/pulls/51`) {
              return Promise.resolve(Response.json({
                number: 51,
                title: "Repair the reviewed Sentinel issue",
                body: "Resolves #48",
                state: merged ? "closed" : "open",
                merged,
                merge_commit_sha: merged ? MERGE : null,
                head: { sha: HEAD },
                base: { ref: "development", sha: BASE },
                user: { login: "ubiquity-sentinel[bot]" },
                merged_by: merged ? { login: "ubiquity-sentinel[bot]" } : null,
              }));
            }
            if (path === `${scope}/commits/${MERGE}`) {
              return Promise.resolve(Response.json({
                parents: [{ sha: movedBase ? "d".repeat(40) : BASE }],
              }));
            }
            const comparedBase =
              path === `${scope}/compare/${MERGE}...development`
                ? MERGE
                : path === `${scope}/compare/${BASE}...${MERGE}`
                ? BASE
                : null;
            assert.notEqual(comparedBase, null, path);
            return Promise.resolve(Response.json({
              status: "ahead",
              base_commit: { sha: comparedBase },
              merge_base_commit: { sha: comparedBase },
            }));
          }) as typeof fetch;
        try {
          const api = createHostedAutonomyGitHub("fixture-token", SELF_REPO);
          github.merge = api.merge;
          github.readPull = api.readPull;
          const result = await run(rig, github);
          assert.deepEqual(writes, [{
            sha: HEAD,
            merge_method: "squash",
            commit_title: "Repair the reviewed Sentinel issue",
            commit_message: "Resolves #48",
          }]);
          const requests = await readRequests(rig);
          if (movedBase) {
            assert.equal(requests.length, 0);
            assert.ok(
              result.actions.some((action) =>
                action.includes("merged_off_tip")
              ),
              JSON.stringify(result.actions),
            );
          } else {
            assert.equal(result.status, "applied");
            assert.equal(requests.length, 1);
            assert.equal(requests[0].revision, MERGE);
            assert.equal(requests[0].source.head, HEAD);
            assert.equal(requests[0].source.base, BASE);
            const landed = await api.readPull(51, "development");
            assert.equal(landed?.mergeMethod, "squash");
            assert.deepEqual(landed?.parents, [BASE]);
          }
        } finally {
          globalThis.fetch = original;
          await Deno.remove(rig.tmp, { recursive: true });
        }
      },
    );
  }
});
