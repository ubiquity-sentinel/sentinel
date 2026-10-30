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
  "src/github/port-evidence.ts",
  "src/github/port-merge-policy.ts",
  "src/host/hosted-app-credentials.ts",
  "src/host/local-config.ts",
  "src/host/local-release.ts",
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
