import assert from "node:assert/strict";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import {
  commitAll,
  producer,
  publicationInput,
  withRepo,
} from "./review-snapshot-helpers.ts";

// Independent inventory of the extracted pointer, admission and dispatch authority.
const authorityPaths = [
  "src/contracts/hosted-supervisor-installation.ts",
  "src/contracts/hosted-supervisor-verification.ts",
  "src/host/actions-supervisor-install-api.ts",
  "src/host/actions-supervisor-installation-state.ts",
  "src/host/actions-supervisor-installation.ts",
  "src/host/actions-supervisor-ordinary.ts",
  "src/host/hosted-runtime-follow-api.ts",
  "src/host/hosted-runtime-follow-ci.ts",
  "src/host/hosted-runtime-follow-dispatch.ts",
  "src/host/hosted-runtime-follow-main.ts",
  "src/host/hosted-runtime-follow-state.ts",
  "src/host/hosted-runtime-follow.ts",
  "src/host/hosted-runtime-rollback-state.ts",
  "src/host/hosted-runtime-rollback.ts",
  ".github/actions/hosted-runtime-control/action.yml",
  "ops/hosted-autonomy-original-candidate.ts",
  "ops/hosted-autonomy-original-candidate-pass.ts",
  "src/host/matrix-blocked-candidate.ts",
  "ops/hosted-autonomy-current-recovery.ts",
  "ops/hosted-autonomy-producer-requests.ts",
  "ops/hosted-autonomy-producer-recovery.ts",
  "src/github/codex-reviewer.ts",
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
      // The protected caller remains byte-identical; imported files need their own protection.
      await writeFile(
        repo,
        "src/host/actions-supervisor-controller.ts",
        'export { planLauncherInstallation } from "./actions-supervisor-installation.ts";\n',
      );
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
