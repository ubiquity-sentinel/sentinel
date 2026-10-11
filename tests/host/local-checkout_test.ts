import assert from "node:assert/strict";
import {
  createLocalCandidateLoader,
  ensureBareStateRepository,
  localCheckoutKey,
  type LocalRepairHostOptionsV1,
  prepareSourceRepository,
} from "../../src/host/local.ts";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import { gitRun, makeRemoteCtx, SHA1, testGitEnv } from "../state/helpers.ts";
import {
  checkoutFixture,
  checkoutRev,
  GIT_FAILED_TEXT,
  localTestDirEntries,
  localTestPathExists,
  requestCheckout,
} from "./local-test-helpers.ts";

Deno.test(
  "local checkout base: clean base movement advances the exact mapping",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const checkout = `${fixture.stateRoot}/checkouts/${fixture.key}`;
      const mappingPath = `${checkout}.json`;
      const first = await requestCheckout(fixture, fixture.oldBase);
      assert.ok(first.ok);
      assert.equal(first.ok ? first.commitBase : null, fixture.oldBase);
      // An extra ref proves the SAME object store/history is reused.
      await fixture.must(checkout, [
        "update-ref",
        "refs/sentinel/probe",
        fixture.oldBase,
      ]);

      const second = await requestCheckout(fixture, fixture.newBase);
      assert.ok(second.ok);
      assert.equal(second.ok ? second.commitBase : null, fixture.newBase);
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.newBase);
      assert.equal(
        await checkoutRev(fixture, "refs/sentinel/probe"),
        fixture.oldBase,
      );
      const status = await fixture.git(checkout, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      assert.ok(status.ok, status.stderr);
      assert.equal(status.stdout.trim(), "", "checkout stays clean");

      const mapping = JSON.parse(await Deno.readTextFile(mappingPath)) as {
        version: string;
        kind: string;
        taskId: string;
        base: string;
        key: string;
      };
      assert.equal(mapping.base, fixture.newBase);
      assert.equal(mapping.taskId, "issue-1");
      assert.equal(mapping.version, "v1");
      assert.equal(mapping.kind, "local_checkout");
      assert.equal(mapping.key, fixture.key);
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local checkout base: a fresh correction checkout starts at the rejected head",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const prepared = await requestCheckout(fixture, fixture.candidate);
      assert.ok(prepared.ok);
      assert.equal(
        prepared.ok ? prepared.commitBase : null,
        fixture.candidate,
        "the correction checkout is rooted at the rejected candidate",
      );
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.candidate);
      const status = await fixture.git(
        `${fixture.stateRoot}/checkouts/${fixture.key}`,
        ["status", "--porcelain", "--untracked-files=all"],
      );
      assert.ok(status.ok, status.stderr);
      assert.equal(
        status.stdout.trim(),
        "",
        "fresh correction checkout is clean",
      );
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local checkout base: crash after movement before mapping publication recovers",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const checkout = `${fixture.stateRoot}/checkouts/${fixture.key}`;
      const mappingPath = `${checkout}.json`;
      const first = await requestCheckout(fixture, fixture.oldBase);
      assert.ok(first.ok);
      await fixture.must(checkout, [
        "update-ref",
        "refs/sentinel/probe",
        fixture.oldBase,
      ]);
      // Simulate the crash: the clean detached movement happened, the mapping
      // publication did not.
      await fixture.must(checkout, [
        "checkout",
        "-q",
        "--detach",
        fixture.newBase,
      ]);
      const stale = JSON.parse(await Deno.readTextFile(mappingPath)) as {
        base: string;
      };
      assert.equal(stale.base, fixture.oldBase);

      const recovered = await requestCheckout(fixture, fixture.newBase);
      assert.ok(recovered.ok);
      assert.equal(recovered.ok ? recovered.commitBase : null, fixture.newBase);
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.newBase);
      assert.equal(
        await checkoutRev(fixture, "refs/sentinel/probe"),
        fixture.oldBase,
      );
      const mapping = JSON.parse(await Deno.readTextFile(mappingPath)) as {
        base: string;
      };
      assert.equal(mapping.base, fixture.newBase);
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local checkout base: untracked and dirty work refuses and is preserved",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const checkout = `${fixture.stateRoot}/checkouts/${fixture.key}`;
      const mappingPath = `${checkout}.json`;
      const first = await requestCheckout(fixture, fixture.oldBase);
      assert.ok(first.ok);

      await Deno.writeTextFile(`${checkout}/untracked.txt`, "work\n");
      const untracked = await requestCheckout(fixture, fixture.newBase);
      assert.equal(untracked.ok, false, "untracked work refuses the movement");
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.oldBase);
      assert.equal(
        (JSON.parse(await Deno.readTextFile(mappingPath)) as { base: string })
          .base,
        fixture.oldBase,
      );
      assert.equal(
        await Deno.readTextFile(`${checkout}/untracked.txt`),
        "work\n",
      );

      await Deno.remove(`${checkout}/untracked.txt`);
      await Deno.writeTextFile(`${checkout}/file.txt`, "modified\n");
      const dirty = await requestCheckout(fixture, fixture.newBase);
      assert.equal(dirty.ok, false, "dirty work refuses the movement");
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.oldBase);
      assert.equal(
        (JSON.parse(await Deno.readTextFile(mappingPath)) as { base: string })
          .base,
        fixture.oldBase,
      );
      assert.equal(
        await Deno.readTextFile(`${checkout}/file.txt`),
        "modified\n",
      );
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local checkout base: saved candidate, divergent base and malformed mapping refuse",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const checkout = `${fixture.stateRoot}/checkouts/${fixture.key}`;
      const mappingPath = `${checkout}.json`;
      const first = await requestCheckout(fixture, fixture.oldBase);
      assert.ok(first.ok);

      // A saved candidate head is never moved onto a new base.
      await fixture.must(checkout, [
        "fetch",
        "--no-tags",
        fixture.source,
        fixture.candidate,
      ]);
      await fixture.must(checkout, [
        "checkout",
        "-q",
        "--detach",
        fixture.candidate,
      ]);
      const candidateRefused = await requestCheckout(fixture, fixture.newBase);
      assert.equal(candidateRefused.ok, false);
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.candidate);
      assert.equal(
        (JSON.parse(await Deno.readTextFile(mappingPath)) as { base: string })
          .base,
        fixture.oldBase,
      );

      // An unrelated (non-ancestor) requested base is refused untouched.
      await fixture.must(checkout, [
        "checkout",
        "-q",
        "--detach",
        fixture.oldBase,
      ]);
      const divergentRefused = await requestCheckout(
        fixture,
        fixture.divergent,
      );
      assert.equal(divergentRefused.ok, false);
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.oldBase);
      assert.equal(
        (JSON.parse(await Deno.readTextFile(mappingPath)) as { base: string })
          .base,
        fixture.oldBase,
      );

      // A malformed mapping preserves every byte and the checkout itself.
      await Deno.writeTextFile(mappingPath, "{not json\n");
      const malformedRefused = await requestCheckout(fixture, fixture.newBase);
      assert.equal(malformedRefused.ok, false);
      assert.equal(await Deno.readTextFile(mappingPath), "{not json\n");
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.oldBase);
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local durable git: absent and empty paths initialize, nonempty paths and symlinks are preserved",
  async () => {
    const fixture = await checkoutFixture();
    try {
      await Deno.mkdir(fixture.stateRoot, { recursive: true });
      const options: LocalRepairHostOptionsV1 = {
        stateRoot: fixture.stateRoot,
        sourceDir: fixture.source,
        controllerSha: SHA1,
        githubToken: "dummy-token",
        modelToken: "dummy-token",
        codexExecutable: "/nonexistent/sentinel-test-codex",
        denoExecutable: Deno.execPath(),
        trustedPath: fixture.trustedPath,
      };

      // An absent bare state path is initialized in place.
      const absentGit = `${fixture.root}/state.git`;
      await ensureBareStateRepository(absentGit, options, fixture.scratch);
      const absentBare = await fixture.git(absentGit, [
        "rev-parse",
        "--is-bare-repository",
      ]);
      assert.ok(absentBare.ok, absentBare.stderr);
      assert.equal(absentBare.stdout.trim(), "true");

      // An existing EMPTY state directory is still initialized, never skipped.
      const emptyGit = `${fixture.root}/empty.git`;
      await Deno.mkdir(emptyGit);
      await ensureBareStateRepository(emptyGit, options, fixture.scratch);
      const emptyBare = await fixture.git(emptyGit, [
        "rev-parse",
        "--is-bare-repository",
      ]);
      assert.ok(emptyBare.ok, emptyBare.stderr);
      assert.equal(emptyBare.stdout.trim(), "true");

      // An existing nonempty user directory is preserved exactly: no init and
      // no reset of user files.
      const keptGit = `${fixture.root}/kept.git`;
      await Deno.mkdir(keptGit);
      await Deno.writeTextFile(`${keptGit}/keep.txt`, "user work\n");
      await ensureBareStateRepository(keptGit, options, fixture.scratch);
      assert.equal(
        await Deno.readTextFile(`${keptGit}/keep.txt`),
        "user work\n",
      );
      assert.equal(
        await localTestPathExists(`${keptGit}/HEAD`),
        false,
        "a nonempty path is never initialized over user files",
      );

      // A symlink is refused before any Git runs and its target is untouched.
      const gitLinkTarget = `${fixture.root}/git-link-target`;
      await Deno.mkdir(gitLinkTarget);
      const gitLink = `${fixture.root}/git-link`;
      const gitLinked = await new Deno.Command("/bin/ln", {
        args: ["-s", gitLinkTarget, gitLink],
        clearEnv: true,
        stdout: "null",
        stderr: "null",
      }).output();
      assert.equal(gitLinked.code, 0, "the fixture symlink must be created");
      await assert.rejects(
        ensureBareStateRepository(gitLink, options, fixture.scratch),
        (error: unknown) =>
          error instanceof Error && error.message.includes(GIT_FAILED_TEXT),
      );
      assert.deepEqual(
        await localTestDirEntries(gitLinkTarget),
        [],
        "a refused symlink never initializes its target",
      );

      // The source clone helper follows the same absent/empty/preserved rules.
      const absentSource = `${fixture.root}/source-clone`;
      await prepareSourceRepository(absentSource, options, fixture.scratch);
      const absentHead = await fixture.git(absentSource, ["rev-parse", "HEAD"]);
      assert.ok(absentHead.ok, absentHead.stderr);
      assert.equal(absentHead.stdout.trim(), fixture.newBase);

      const emptySource = `${fixture.root}/empty-source`;
      await Deno.mkdir(emptySource);
      await prepareSourceRepository(emptySource, options, fixture.scratch);
      const emptyHead = await fixture.git(emptySource, ["rev-parse", "HEAD"]);
      assert.ok(emptyHead.ok, emptyHead.stderr);
      assert.equal(emptyHead.stdout.trim(), fixture.newBase);

      const keptSource = `${fixture.root}/kept-source`;
      await Deno.mkdir(keptSource);
      await Deno.writeTextFile(`${keptSource}/keep.txt`, "user work\n");
      await prepareSourceRepository(keptSource, options, fixture.scratch);
      assert.equal(
        await Deno.readTextFile(`${keptSource}/keep.txt`),
        "user work\n",
      );
      assert.equal(
        await localTestPathExists(`${keptSource}/.git`),
        false,
        "a nonempty source path is preserved, never reset by a clone",
      );

      const sourceLinkTarget = `${fixture.root}/source-link-target`;
      await Deno.mkdir(sourceLinkTarget);
      const sourceLink = `${fixture.root}/source-link`;
      const sourceLinked = await new Deno.Command("/bin/ln", {
        args: ["-s", sourceLinkTarget, sourceLink],
        clearEnv: true,
        stdout: "null",
        stderr: "null",
      }).output();
      assert.equal(sourceLinked.code, 0, "the fixture symlink must be created");
      await assert.rejects(
        prepareSourceRepository(sourceLink, options, fixture.scratch),
        (error: unknown) =>
          error instanceof Error && error.message.includes(GIT_FAILED_TEXT),
      );
      assert.deepEqual(
        await localTestDirEntries(sourceLinkTarget),
        [],
        "a refused symlink never clones into its target",
      );
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// Candidate objects: exact task-mapped producer-checkout import and the
// trusted-receipt preservation boundary.
// ---------------------------------------------------------------------------

Deno.test(
  "local candidate loader imports only the exact task-mapped candidate",
  async () => {
    // The fixture root MUST be absolute: a relative root is duplicated inside
    // nested Git commands and corrupts every later path assertion.
    const root = await Deno.realPath(
      await Deno.makeTempDir({
        dir: ".",
        prefix: "sentinel-candidate-loader-",
      }),
    );
    const home = `${root}/home`;
    const env = testGitEnv(home);
    await Deno.mkdir(home, { recursive: true });
    try {
      const ctx = await makeRemoteCtx(root, env);
      await Deno.writeTextFile(`${ctx.work}/base.txt`, "base\n");
      assert.ok((await gitRun(ctx.work, ["add", "-A"], env)).ok);
      assert.ok(
        (await gitRun(ctx.work, ["commit", "-q", "-m", "base"], env)).ok,
      );
      assert.ok(
        (await gitRun(ctx.work, ["branch", "-M", "development"], env)).ok,
      );
      const base = (await gitRun(ctx.work, ["rev-parse", "HEAD"], env))
        .stdout.trim() as GitSha;
      await Deno.writeTextFile(`${ctx.work}/candidate.txt`, "candidate\n");
      assert.ok((await gitRun(ctx.work, ["add", "-A"], env)).ok);
      assert.ok(
        (await gitRun(ctx.work, ["commit", "-q", "-m", "candidate"], env)).ok,
      );
      const head = (await gitRun(ctx.work, ["rev-parse", "HEAD"], env))
        .stdout.trim() as GitSha;

      const stateRoot = `${root}/state`;
      const taskId = asWorkItemId("issue-42");
      const key = await localCheckoutKey(taskId);
      const checkoutsDir = `${stateRoot}/checkouts`;
      const checkout = `${checkoutsDir}/${key}`;
      const mappingPath = `${checkoutsDir}/${key}.json`;
      await Deno.mkdir(checkoutsDir, { recursive: true });
      const cloneInto = async (destination: string, source: string) => {
        assert.ok(
          (await gitRun(
            root,
            ["clone", "-q", "--no-hardlinks", source, destination],
            env,
          )).ok,
        );
      };
      const mapping = (
        value: string,
        overrides: Record<string, unknown> = {},
      ) =>
        JSON.stringify({
          version: "v1",
          kind: "local_checkout",
          taskId: value,
          base,
          key,
          ...overrides,
        }) + "\n";
      const freshSource = async (name: string): Promise<string> => {
        const source = `${root}/${name}`;
        assert.ok(
          (await gitRun(root, ["init", "-q", "--bare", source], env)).ok,
        );
        return source;
      };
      const load = (source: string) =>
        createLocalCandidateLoader({
          stateRoot,
          sourcePath: source,
          scratch: home,
          trustedPath: env.PATH ?? "/usr/bin:/bin",
        });
      // A genuinely base-only mirror and checkout: a clone of ctx.work keeps
      // carrying the candidate object, which would invalidate every later
      // absence assertion.
      const baseOnly = `${root}/base-only.git`;
      assert.ok(
        (await gitRun(root, ["init", "-q", "--bare", baseOnly], env)).ok,
      );
      assert.ok(
        (await gitRun(
          ctx.work,
          ["push", "-q", baseOnly, `${base}:refs/heads/development`],
          env,
        )).ok,
      );
      const resetBaseOnlyCheckout = async () => {
        await Deno.remove(checkout, { recursive: true }).catch(() => {});
        await cloneInto(checkout, baseOnly);
        assert.ok(
          (await gitRun(checkout, ["checkout", "-q", "--detach", base], env))
            .ok,
        );
      };

      // 1. A fresh empty source mirror imports the exact candidate from the
      // exact task-mapped producer checkout.
      await cloneInto(checkout, ctx.work);
      await Deno.writeTextFile(mappingPath, mapping(taskId));
      const sourceA = await freshSource("source-a.git");
      const loaded = await load(sourceA)(taskId, head);
      assert.ok(loaded.ok, JSON.stringify(loaded));
      const imported = await gitRun(
        sourceA,
        ["rev-parse", `refs/sentinel/candidates/${key}`],
        env,
      );
      assert.equal(imported.stdout.trim(), head);
      assert.equal(
        (await gitRun(sourceA, ["cat-file", "-e", `${base}^{commit}`], env))
          .code,
        0,
      );

      // 2. The positive moved-HEAD case: HEAD is detached at the base while
      // the exact object still exists, so the exact object is imported and no
      // mutable HEAD is ever resolved.
      assert.ok(
        (await gitRun(checkout, ["checkout", "-q", "--detach", base], env)).ok,
      );
      const sourceB = await freshSource("source-b.git");
      const moved = await load(sourceB)(taskId, head);
      assert.ok(moved.ok, JSON.stringify(moved));
      assert.equal(
        (await gitRun(
          sourceB,
          ["rev-parse", `refs/sentinel/candidates/${key}`],
          env,
        )).stdout.trim(),
        head,
      );

      // 3. A source mirror that cannot be read is unavailable, never loss.
      const unreadable = await load(`${root}/no-such-source.git`)(taskId, head);
      assert.equal(unreadable.ok, false);
      assert.equal(unreadable.ok ? null : unreadable.error.kind, "unavailable");

      await resetBaseOnlyCheckout();

      // 4. A wrong-task mapping is unknown availability even though the exact
      // object is genuinely absent from this checkout: never positive loss.
      await Deno.writeTextFile(mappingPath, mapping(asWorkItemId("issue-43")));
      const wrongTask = await load(await freshSource("source-c.git"))(
        taskId,
        head,
      );
      assert.equal(wrongTask.ok, false);
      assert.equal(wrongTask.ok ? null : wrongTask.error.kind, "unavailable");

      // 5. Corrupt JSON and mismatched metadata are the same unknown state.
      await Deno.writeTextFile(mappingPath, "{ not json\n");
      const corrupt = await load(await freshSource("source-d.git"))(
        taskId,
        head,
      );
      assert.equal(corrupt.ok, false);
      assert.equal(corrupt.ok ? null : corrupt.error.kind, "unavailable");
      await Deno.writeTextFile(mappingPath, mapping(taskId, { version: "v2" }));
      const wrongVersion = await load(await freshSource("source-e.git"))(
        taskId,
        head,
      );
      assert.equal(wrongVersion.ok, false);
      assert.equal(
        wrongVersion.ok ? null : wrongVersion.error.kind,
        "unavailable",
      );

      // 6. A present path that is not a usable Git store can never prove
      // absence.
      await Deno.writeTextFile(mappingPath, mapping(taskId));
      await Deno.remove(checkout, { recursive: true });
      await Deno.writeTextFile(checkout, "not a git repository\n");
      const invalidStore = await load(await freshSource("source-f.git"))(
        taskId,
        head,
      );
      assert.equal(invalidStore.ok, false);
      assert.equal(
        invalidStore.ok ? null : invalidStore.error.kind,
        "unavailable",
      );

      // 7. An exact mapping with a proven-missing checkout is positive loss.
      await Deno.remove(checkout);
      const absentCheckout = await load(await freshSource("source-g.git"))(
        taskId,
        head,
      );
      assert.equal(absentCheckout.ok, false);
      assert.equal(
        absentCheckout.ok ? null : absentCheckout.error.kind,
        "not_found",
      );

      // 8. The exact mapped checkout without the exact object is positive
      // loss: this checkout genuinely has only the base commit.
      await resetBaseOnlyCheckout();
      const absentObject = await load(await freshSource("source-h.git"))(
        taskId,
        head,
      );
      assert.equal(absentObject.ok, false);
      assert.equal(
        absentObject.ok ? null : absentObject.error.kind,
        "not_found",
      );

      // 9. A never-published producer (no mapping, no checkout) is the same
      // proven absence.
      await Deno.remove(mappingPath);
      await Deno.remove(checkout, { recursive: true });
      const never = await load(await freshSource("source-i.git"))(taskId, head);
      assert.equal(never.ok, false);
      assert.equal(never.ok ? null : never.error.kind, "not_found");
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);
