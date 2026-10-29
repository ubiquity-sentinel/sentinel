/**
 * Materialization in the trusted job (docs/backup-ci-spec.md §9.4, A7),
 * with real git against a temporary target remote: fetch by exact SHA; the
 * synthetic merge M has parents [B, H] and tree(H) and is authored by
 * GitHub at the planned time; a base that was not fetched is refused; a
 * workflow with a symlink mode is not a readable file; the read token never
 * appears in argv or `config` and travels only as `GIT_CONFIG_VALUE_0`;
 * children run with a cleared environment; the tar is deterministic, keeps
 * symlinks as links, and is refused when a credential leaked. Synthetic.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  BACKUP_CI_EXEC_REF,
  backupCiFetchAuthEnv,
  type BackupCiGitV1,
  backupCiTokenNeedles,
  createBackupCiGit,
  fetchBackupCiBare,
  packBackupCiBare,
} from "../../ops/backup-ci-materialize.ts";
import { readBackupCiWorkflow } from "../../ops/backup-ci-workflow-map.ts";
import {
  fixtureGit,
  fixtureSymlink,
  PASSPORT_WORKFLOW,
  targetRepo,
  type TargetRepoV1,
  testDir,
  WORKFLOW_PATH,
} from "./backup-ci-test-repo.ts";

const TOKEN = "ghs_SYNTHETICtoken0123456789abcdefABCDEF";

function recording(inner: BackupCiGitV1) {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const git: BackupCiGitV1 = {
    runGit(args, opts) {
      calls.push({ args: [...args], env: { ...(opts.env ?? {}) } });
      return inner.runGit(args, opts);
    },
  };
  return { git, calls };
}

async function rig(): Promise<
  { repo: TargetRepoV1; base: GitSha; head: GitSha }
> {
  const repo = await targetRepo("backup-ci-materialize-");
  const base = await repo.commit({
    [WORKFLOW_PATH]: PASSPORT_WORKFLOW,
    "src/main.ts": "export const x = 1;\n",
  });
  const head = await repo.commit({
    "src/main.ts": "export const x = 2;\n",
    "scripts/run.sh": { text: "#!/bin/sh\necho ok\n", mode: 0o755 },
    "link": { symlink: "src/main.ts" },
  });
  return { repo, base, head };
}

Deno.test("fetch by SHA, then the synthetic merge M = [B, H], tree(H)", async () => {
  const { repo, base, head } = await rig();
  try {
    const { git, calls } = recording(createBackupCiGit(`${repo.root}/home`));
    const bare = await fetchBackupCiBare({
      git,
      dir: `${repo.root}/m/bare`,
      remoteUrl: repo.url,
      token: TOKEN,
      commits: [head, base],
      protocols: ["file"],
    });
    assert(bare !== null);
    assert.equal(await bare.objectType(head), "commit");
    assert.equal(await bare.objectType(base), "commit");
    const plannedAt = Date.parse("2026-10-25T08:00:00Z");
    const merge = await bare.syntheticMerge(base, head, plannedAt);
    assert(merge !== null);
    assert.deepEqual(await bare.rawParents(merge), [base, head]);
    assert.equal(await bare.treeOf(merge), await bare.treeOf(head));
    const raw = await fixtureGit(bare.dir, ["cat-file", "commit", merge]);
    const seconds = plannedAt / 1000;
    assert(
      raw.includes(`\nauthor GitHub <noreply@github.com> ${seconds} +0000\n`),
    );
    assert(
      raw.includes(
        `\ncommitter GitHub <noreply@github.com> ${seconds} +0000\n`,
      ),
    );
    assert.match(raw, new RegExp(`Merge ${head} into ${base}`));
    // The same inputs give the same M (a re-plan is the same unit).
    assert.equal(await bare.syntheticMerge(base, head, plannedAt), merge);
    assert(await bare.setExec(merge));
    assert.equal(
      await fixtureGit(bare.dir, ["symbolic-ref", "HEAD"]),
      BACKUP_CI_EXEC_REF,
    );
    // The token went only to the fetch, as a GIT_CONFIG header value.
    for (const call of calls) {
      assert(!call.args.some((a) => a.includes(TOKEN)), call.args.join(" "));
      const withToken = Object.entries(call.env).filter(([, v]) =>
        backupCiTokenNeedles(TOKEN).some((n) => v.includes(n))
      );
      if (call.args.includes("fetch")) {
        assert.deepEqual(call.env, backupCiFetchAuthEnv(TOKEN));
        assert.deepEqual(withToken.map(([k]) => k), ["GIT_CONFIG_VALUE_0"]);
      } else assert.deepEqual(withToken, []);
      assert(call.args.includes("core.hooksPath=/dev/null"));
      assert(call.args.includes("protocol.allow=never"));
    }
    const config = await Deno.readTextFile(`${bare.dir}/config`);
    assert(!config.includes(TOKEN) && !/extraheader/i.test(config));
  } finally {
    await repo.close();
  }
});

Deno.test("a base that is not a fetched commit is refused", async () => {
  const { repo, base, head } = await rig();
  try {
    const git = createBackupCiGit(`${repo.root}/home`);
    const bare = await fetchBackupCiBare({
      git,
      dir: `${repo.root}/m/bare`,
      remoteUrl: repo.url,
      token: null,
      commits: [head],
      protocols: ["file"],
    });
    assert(bare !== null);
    assert.equal(await bare.syntheticMerge(base, head, 0), null);
    assert.equal(
      await fetchBackupCiBare({
        git,
        dir: `${repo.root}/n/bare`,
        remoteUrl: repo.url,
        token: null,
        commits: ["0".repeat(40) as GitSha],
        protocols: ["file"],
      }),
      null,
    );
    // Without the test-only file transport, a file remote is refused.
    assert.equal(
      await fetchBackupCiBare({
        git,
        dir: `${repo.root}/o/bare`,
        remoteUrl: repo.url,
        token: null,
        commits: [head],
      }),
      null,
    );
  } finally {
    await repo.close();
  }
});

Deno.test("a workflow with a symlink mode is not a readable workflow", async () => {
  const repo = await targetRepo("backup-ci-materialize-link-");
  try {
    await repo.commit({ "real.yml": PASSPORT_WORKFLOW });
    const commit = await repo.commit({
      [WORKFLOW_PATH]: { symlink: "../../real.yml" },
    });
    const bare = await fetchBackupCiBare({
      git: createBackupCiGit(`${repo.root}/home`),
      dir: `${repo.root}/m/bare`,
      remoteUrl: repo.url,
      token: null,
      commits: [commit],
      protocols: ["file"],
    });
    assert(bare !== null);
    const entry = await bare.entry(commit, WORKFLOW_PATH);
    assert.equal(entry?.mode, "120000");
    assert.equal(await bare.readFile(commit, WORKFLOW_PATH, 1 << 20), null);
    const bytes = await bare.readBlob(entry!.oid, 1 << 20);
    const workflow = readBackupCiWorkflow(WORKFLOW_PATH, entry!.mode, bytes!);
    assert(!workflow.ok && workflow.reason === "workflow_unreadable");
    assert.equal(await bare.readBlob(entry!.oid, 1), null);
  } finally {
    await repo.close();
  }
});

Deno.test("git children run with a cleared environment", async () => {
  const root = await testDir("backup-ci-env-");
  try {
    const out = await createBackupCiGit(`${root}/home`).runGit(
      ["-c", "alias.envdump=!env", "envdump"],
      { cwd: root, env: { EXTRA: "1" } },
    );
    assert(out.ok, out.stderr);
    const keys = out.stdout.split("\n").filter((l) => l.includes("="))
      .map((l) => l.slice(0, l.indexOf("=")));
    const allowed = /^(?:PATH|HOME|PWD|OLDPWD|SHLVL|_|EXTRA|GIT_[A-Z_]+)$/;
    assert.deepEqual(keys.filter((k) => !allowed.test(k)), []);
    assert(
      keys.includes("GIT_CONFIG_GLOBAL") &&
        keys.includes("GIT_TERMINAL_PROMPT"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the tar is deterministic, keeps links and refuses a leaked credential", async () => {
  const { repo, head } = await rig();
  try {
    const bare = await fetchBackupCiBare({
      git: createBackupCiGit(`${repo.root}/home`),
      dir: `${repo.root}/m/bare`,
      remoteUrl: repo.url,
      token: TOKEN,
      commits: [head],
      protocols: ["file"],
    });
    assert(bare !== null);
    assert(await bare.setExec(head));
    await Deno.writeTextFile(`${bare.dir}/unit.json`, "{}");
    await fixtureSymlink("/etc/passwd", `${bare.dir}/outside`);
    const needles = backupCiTokenNeedles(TOKEN);
    const a = await packBackupCiBare(bare, `${repo.root}/a.tar`, needles);
    const b = await packBackupCiBare(bare, `${repo.root}/b.tar`, needles);
    assert(a.ok && b.ok);
    assert.equal(a.sha256, b.sha256);
    const listing = await new Deno.Command("tar", {
      args: ["-tvf", `${repo.root}/a.tar`, "--numeric-owner"],
      stdout: "piped",
    }).output();
    const lines = new TextDecoder().decode(listing.stdout).trim().split("\n");
    assert(
      lines.every((l) => / 0\/0 /.test(l) && / bare(\/|$)/.test(l)),
      lines.join("\n"),
    );
    assert(
      lines.some((l) =>
        l.startsWith("l") && l.includes("bare/outside -> /etc/passwd")
      ),
    );
    assert(lines.some((l) => l.endsWith("bare/unit.json")));
    await Deno.remove(`${bare.dir}/outside`);
    await Deno.writeTextFile(
      `${bare.dir}/config`,
      `[http]\n\textraheader = x\n`,
      { append: true },
    );
    const leaked = await packBackupCiBare(bare, `${repo.root}/c.tar`, needles);
    assert(!leaked.ok && leaked.reason === "credential");
    await fixtureGit(bare.dir, ["config", "--unset", "http.extraheader"]);
    await Deno.writeTextFile(`${bare.dir}/unit.json`, `{"t":"${TOKEN}"}`);
    const inTar = await packBackupCiBare(bare, `${repo.root}/d.tar`, needles);
    assert(!inTar.ok && inTar.reason === "credential");
    assert(
      await Deno.lstat(`${repo.root}/d.tar`).then(() => false, () => true),
    );
  } finally {
    await repo.close();
  }
});
