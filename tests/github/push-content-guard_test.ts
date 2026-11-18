/**
 * The push-time backstop of the 2026-11-17 workflow-trust gate: a pushed
 * branch that changes a workflow runs with the target's secrets before any
 * pull request exists, so every push of model-written content re-derives the
 * paths it carries from the actual `base..head` tree diff in the pusher's own
 * object store (NUL-separated raw paths, never a receipt's list) and refuses
 * a CI-executable change its source may not make. Real Git, a disposable bare
 * remote, no credentials.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { PushContentGuardV1 } from "../../src/contracts/ports-github.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import {
  PUSH_PATHS_UNAVAILABLE,
  PUSH_TRUST_UNAVAILABLE,
} from "../../src/github/push-content-guard.ts";
import {
  PROTECTED_PATH_PARK,
  UNTRUSTED_WORKFLOW_PARK,
  type WorkflowTrustV1,
} from "../../src/repair/workflow-trust.ts";
import { FakeGitExecutor, makePort, SHA1, SHA2 } from "./helpers.ts";

const TARGET = { owner: "ubiquity", name: "pay.ubq.fi", installationId: 7 };
const SELF = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 7,
};
const REF = "heads/sentinel/repair/issue-41";
/** A workflow path git C-quotes without `-z`. */
const WORKFLOW = ".github/workflows/déploy.yml";

async function git(cwd: string, env: Record<string, string>, args: string[]) {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

/** A base commit and one candidate adding `paths`, beside a bare remote. */
async function world(paths: string[]) {
  const tmp = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-push-guard-",
  });
  const env = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: `${tmp}/home`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "push-guard-test",
    GIT_AUTHOR_EMAIL: "push-guard-test@localhost",
    GIT_COMMITTER_NAME: "push-guard-test",
    GIT_COMMITTER_EMAIL: "push-guard-test@localhost",
  };
  await Deno.mkdir(`${tmp}/home`);
  const work = `${tmp}/work`, bare = `${tmp}/remote.git`;
  await git(tmp, env, ["init", "-q", "--bare", bare]);
  await git(tmp, env, ["init", "-q", work]);
  await Deno.writeTextFile(`${work}/README.md`, "base\n");
  await git(work, env, ["add", "-A"]);
  await git(work, env, ["commit", "-q", "-m", "base"]);
  const base = await git(work, env, ["rev-parse", "HEAD"]) as GitSha;
  for (const path of paths) {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (dir !== "") await Deno.mkdir(`${work}/${dir}`, { recursive: true });
    await Deno.writeTextFile(`${work}/${path}`, "candidate\n");
  }
  await git(work, env, ["add", "-A"]);
  await git(work, env, ["commit", "-q", "-m", "candidate"]);
  const head = await git(work, env, ["rev-parse", "HEAD"]) as GitSha;
  const executor = new DenoGitExecutor({
    localDir: work,
    remoteUrl: bare,
    gitHome: `${tmp}/home`,
  });
  const remote = async () => {
    const read = await executor.readRemoteRef(REF);
    return read.ok ? read.value : "unreadable";
  };
  return {
    base,
    head,
    executor,
    remote,
    cleanup: () => Deno.remove(tmp, { recursive: true }),
  };
}

function guard(
  base: GitSha,
  trust: WorkflowTrustV1,
  reads: string[],
  ownRepository = false,
): PushContentGuardV1 {
  return {
    base,
    ownRepository,
    trust: () => {
      reads.push(trust);
      return Promise.resolve(trust);
    },
  };
}

Deno.test("push guard: a raw workflow path is pushed only on a trusted source", async () => {
  const cases: [WorkflowTrustV1, unknown][] = [
    ["untrusted", { kind: "invalid", detail: UNTRUSTED_WORKFLOW_PARK }],
    ["unavailable", { kind: "unavailable", detail: PUSH_TRUST_UNAVAILABLE }],
    ["trusted", null],
  ];
  for (const [trust, refused] of cases) {
    const w = await world(["src/app.ts", WORKFLOW]);
    try {
      const { port } = makePort({ repository: TARGET, git: w.executor });
      const reads: string[] = [];
      const result = await port.pushHead(
        REF,
        w.head,
        null,
        undefined,
        guard(w.base, trust, reads),
      );
      assert.deepEqual(reads, [trust], "the source trust is read once");
      if (refused === null) {
        assert.deepEqual(result, { ok: true, value: "applied" });
        assert.equal(await w.remote(), w.head);
      } else {
        assert.deepEqual(result, { ok: false, error: refused }, trust);
        assert.equal(await w.remote(), null, "nothing was sent");
      }
    } finally {
      await w.cleanup();
    }
  }
});

Deno.test("push guard: a change with no CI-executable path is pushed without a trust read", async () => {
  const w = await world(["src/app.ts", "docs/.github-notes.md"]);
  try {
    const { port } = makePort({ repository: TARGET, git: w.executor });
    const reads: string[] = [];
    const result = await port.pushHead(
      REF,
      w.head,
      null,
      undefined,
      guard(w.base, "untrusted", reads),
    );
    assert.deepEqual(result, { ok: true, value: "applied" });
    assert.deepEqual(reads, []);
  } finally {
    await w.cleanup();
  }
});

Deno.test("push guard: on Sentinel's own repository any CI-executable push is refused, whatever the caller claims", async () => {
  for (const path of [WORKFLOW, ".github/dependabot.yml", "src/we\\ird.ts"]) {
    const w = await world(["src/app.ts", path]);
    try {
      const { port } = makePort({ repository: SELF, git: w.executor });
      const reads: string[] = [];
      const result = await port.pushHead(
        REF,
        w.head,
        null,
        undefined,
        guard(w.base, "trusted", reads, false),
      );
      assert.deepEqual(result, {
        ok: false,
        error: { kind: "invalid", detail: PROTECTED_PATH_PARK },
      }, path);
      assert.deepEqual(reads, [], "no trust can lift it");
      assert.equal(await w.remote(), null);
    } finally {
      await w.cleanup();
    }
  }
});

Deno.test("push guard: an executor that cannot read the change set never pushes", async () => {
  const executor = new FakeGitExecutor();
  executor.changed = null;
  const { port } = makePort({ repository: TARGET, git: executor });
  const result = await port.pushHead(
    REF,
    SHA2,
    null,
    undefined,
    guard(SHA1, "trusted", []),
  );
  assert.deepEqual(result, {
    ok: false,
    error: { kind: "unavailable", detail: PUSH_PATHS_UNAVAILABLE },
  });
  assert.deepEqual(executor.pushes, []);
});
