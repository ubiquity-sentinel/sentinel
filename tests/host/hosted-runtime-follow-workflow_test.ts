import assert from "node:assert/strict";
import { runHostedRuntimeFollowMain } from "../../src/host/hosted-runtime-follow-main.ts";
import { FollowFake, L, OLDER } from "./hosted-runtime-follow-fixtures.ts";

Deno.test("follow Actions adapter defaults off, writes only summary/output, and records exact CI identities", async () => {
  const api = new FollowFake();
  const writes = new Map<string, string>();
  const environment = new Map([
    ["GITHUB_TOKEN", "fake-token"],
    ["GITHUB_OUTPUT", "output"],
    ["GITHUB_STEP_SUMMARY", "summary"],
  ]);
  const requested: string[] = [];
  const exitCode = await runHostedRuntimeFollowMain({
    env: (name) => {
      requested.push(name);
      return environment.get(name);
    },
    http: api.http,
    log: (line) => api.journals.push(line),
    write: (path, text, options) => {
      assert.equal(options.append, true);
      writes.set(path, text);
      return Promise.resolve();
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(api.mutations, 0);
  assert.equal(api.journals[0].decision, "dry_run");
  assert.equal(api.journals[0].candidateSha, OLDER);
  assert.equal(
    writes.get("output"),
    `launcher-sha=${L}\nfollow-ready=true\ndecision=dry_run\n`,
  );
  assert.ok(writes.get("summary")!.includes(JSON.stringify(api.journals[0])));
  assert.deepEqual(
    new Set(requested),
    new Set([
      "GITHUB_TOKEN",
      "SENTINEL_AUTO_FOLLOW",
      "GITHUB_OUTPUT",
      "GITHUB_STEP_SUMMARY",
    ]),
  );
  assert.ok(!writes.get("summary")!.includes("fake-token"));
});

Deno.test("follow Actions adapter never publishes dispatch readiness on a mismatched readback", async () => {
  const api = new FollowFake();
  api.mutation = "mismatch";
  const writes: string[] = [];
  const exitCode = await runHostedRuntimeFollowMain({
    env: (name) =>
      ({
        GITHUB_TOKEN: "fake-token",
        SENTINEL_AUTO_FOLLOW: "on",
        GITHUB_OUTPUT: "output",
      })[name],
    http: api.http,
    log: () => {},
    write: (_path, text) => {
      writes.push(text);
      return Promise.resolve();
    },
  });
  assert.equal(exitCode, 1);
  assert.ok(writes[0].includes("follow-ready=false"));
});

Deno.test("follow workflow uses only the checked-out dispatcher action before fixed-ref dispatch", async () => {
  const workflow = await Deno.readTextFile(
    ".github/workflows/supervisor-dispatch.yml",
  );
  const action = await Deno.readTextFile(
    ".github/actions/hosted-runtime-control/action.yml",
  );
  const deno = JSON.parse(await Deno.readTextFile("deno.json"));
  assert.ok(workflow.includes("contents: write"));
  assert.ok(workflow.includes("actions: write"));
  assert.ok(workflow.includes("ref: ${{ github.sha }}"));
  assert.ok(workflow.includes("persist-credentials: false"));
  assert.ok(
    workflow.includes("auto-follow: ${{ vars.SENTINEL_AUTO_FOLLOW || 'on' }}"),
  );
  assert.ok(
    workflow.indexOf("uses: ./.github/actions/hosted-runtime-control") <
      workflow.indexOf(
        "src/host/supervisor-dispatch.ts",
        workflow.indexOf("steps:"),
      ),
  );
  assert.ok(workflow.includes("sentinel_parent_run_id"));
  assert.ok(workflow.includes("parent supervisor did not complete"));
  const supervisor = await Deno.readTextFile(
    ".github/workflows/supervisor.yml",
  );
  assert.ok(supervisor.includes("Chain the next dispatcher run"));
  assert.ok(
    supervisor.includes(
      "gh workflow run supervisor-dispatch.yml",
    ),
  );
  assert.ok(
    supervisor.includes('sentinel_parent_run_id="${{ github.run_id }}"'),
  );
  assert.ok(supervisor.includes("actions: write"));
  assert.ok(
    workflow.includes(
      "SENTINEL_FOLLOW_SHA: ${{ steps.follow.outputs.launcher-sha }}",
    ),
  );
  assert.ok(
    workflow.includes(
      "SENTINEL_FOLLOW_READY: ${{ steps.follow.outputs.follow-ready }}",
    ),
  );
  assert.ok(action.includes("run: deno task follow:run"));
  assert.ok(!/uses:.*@/.test(action));
  assert.ok(
    !/secrets\.|APP_PRIVATE|UOS_AI_TOKEN|MODEL_/.test(action + workflow),
  );
  assert.equal(
    deno.tasks["follow:run"],
    "deno run --allow-net=api.github.com --allow-write --allow-env=GITHUB_TOKEN,SENTINEL_AUTO_FOLLOW,GITHUB_OUTPUT,GITHUB_STEP_SUMMARY src/host/hosted-runtime-follow-main.ts",
  );
  assert.ok(!deno.tasks["follow:run"].includes("--allow-run"));
});
