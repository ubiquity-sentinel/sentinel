import assert from "node:assert/strict";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import {
  commitAll,
  producer,
  publicationInput,
  withRepo,
} from "./review-snapshot-helpers.ts";

// Owner directive 2026-10-30: the published set is exactly the credential,
// token-dispatch, merge-gate and promotion authority.
const authorityPaths = [
  "src/host/hosted-authority-protected-paths.ts",
  "src/contracts/hosted-controller-deployment.ts",
  "src/host/supervisor-dispatch.ts",
  "src/host/actions-premerge-ci.ts",
  "src/host/hosted-runtime-follow.ts",
  "src/host/hosted-runtime-follow-ci.ts",
  "src/host/hosted-runtime-follow-dispatch.ts",
  // The auto-follow API's token and `updateRefs` mutation, the installed and
  // failed revision state, and the adapter that reads `GITHUB_TOKEN`.
  "src/host/hosted-runtime-follow-api.ts",
  "src/host/hosted-runtime-follow-state.ts",
  "src/host/hosted-runtime-follow-main.ts",
  ".github/actions/hosted-runtime-control/action.yml",
  "src/github/port-evidence.ts",
  "src/github/port-merge-policy.ts",
  "src/github/port-merge.ts",
  // Gate dependencies: a candidate that edits only one of these must still be
  // refused; `port-merge-policy.ts` imports `ci-rejection.ts`, and
  // `port-merge.ts` imports `loop-checks.ts`, which imports `ci-rejection.ts`.
  "src/repair/loop-checks.ts",
  "src/repair/ci-rejection.ts",
  "src/host/hosted-app-credentials.ts",
  ".github/actions/sentinel-app-token/action.yml",
  "src/host/actions-target-bindings.ts",
  "src/host/hosted-app-grant.ts",
  "src/host/actions-target-cycles.ts",
  // Host composition that selects and binds the credentials, and the hosted
  // admission predicate that admits model work.
  "src/host/actions-repair-host.ts",
  "src/host/actions-supervisor-host.ts",
  "src/host/hosted-app-principal.ts",
  "src/contracts/hosted-supervisor-verification.ts",
  // The unchanged `touchesProtected` predicate: if it could be edited, the
  // whole boundary could return false after merge.
  "src/repair/loop-records.ts",
  "src/host/local-config.ts",
  "src/host/local-release.ts",
  "src/host/local-supervisor-release.ts",
  "src/host/actions-supervisor-installation.ts",
  // The hosted promotion callers and installation parsers that choose and
  // verify revisions before the protected pointer writer applies them.
  "src/host/local-supervisor.ts",
  "src/host/actions-supervisor-source.ts",
  "src/host/actions-supervisor-controller.ts",
  "src/host/actions-supervisor-install-api.ts",
  "src/contracts/local-release.ts",
  ".github/workflows/ci.yml",
];

async function writeFile(repo: string, path: string, text: string) {
  await Deno.mkdir(`${repo}/${path.slice(0, path.lastIndexOf("/"))}`, {
    recursive: true,
  });
  await Deno.writeTextFile(`${repo}/${path}`, text);
}

for (const path of authorityPaths) {
  Deno.test(`publication: extracted hosted authority refuses ${path}`, async () => {
    await withRepo(async (repo) => {
      // A protected file needs no caller to refuse a model-authored edit.
      await writeFile(repo, path, "trusted authority fixture\n");
      const base = await commitAll(repo, "trusted base");
      await writeFile(repo, path, "candidate changed authority fixture\n");
      const head = await commitAll(repo, "candidate authority edit");
      const result = await producer(repo).validatePublication(
        publicationInput(base, head, {
          protectedPaths: createLocalRepositoryConfig().protectedPaths,
        }),
      );
      assert.ok(!result.ok, `${path} must be refused before publication`);
      if (result.ok) assert.fail("expected authority refusal");
      assert.equal(result.error.kind, "invalid");
      assert.equal(
        result.error.detail,
        "publication validation unavailable: a protected entry does not match the trusted base tree",
      );
    });
  });
}

Deno.test("publication: ordinary source and local action edits retain the production protection policy", async () => {
  await withRepo(async (repo) => {
    const paths = [
      "src/host/ordinary-feature.ts",
      ".github/actions/ordinary-action/main.js",
      // Formerly protected review and queue files are ordinary work again.
      "src/github/codex-reviewer.ts",
      "src/repair/loop-review-result.ts",
    ];
    for (const path of paths) await writeFile(repo, path, "ordinary fixture\n");
    const base = await commitAll(repo, "ordinary base");
    for (const path of paths) {
      await writeFile(repo, path, "candidate changed ordinary fixture\n");
    }
    const head = await commitAll(repo, "ordinary candidate edit");
    const result = await producer(repo).validatePublication(
      publicationInput(base, head, {
        protectedPaths: createLocalRepositoryConfig().protectedPaths,
      }),
    );
    assert.ok(result.ok, JSON.stringify(result));
  });
});
