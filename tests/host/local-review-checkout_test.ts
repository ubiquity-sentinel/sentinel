import assert from "node:assert/strict";
import { prepareReviewCheckout } from "../../src/host/local.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  checkoutFixture,
  localTestLink,
  localTestPathExists,
} from "./local-test-helpers.ts";

Deno.test(
  "local review checkout: exact detached independent checkout with verified reuse",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const reviewCheckout = `${fixture.stateRoot}/review-checkout`;
      await Deno.mkdir(reviewCheckout, { recursive: true });
      const first = await prepareReviewCheckout({
        sourcePath: fixture.source,
        reviewCheckout,
        base: fixture.oldBase as GitSha,
        head: fixture.candidate as GitSha,
        trustedPath: fixture.trustedPath,
        scratch: fixture.scratch,
      });
      assert.ok(first.ok, first.ok ? "" : first.error.detail);

      const dotGit = await Deno.lstat(`${reviewCheckout}/.git`);
      assert.ok(
        dotGit.isDirectory && !dotGit.isSymlink,
        "the checkout owns a real local .git directory",
      );
      assert.equal(
        await localTestPathExists(
          `${reviewCheckout}/.git/objects/info/alternates`,
        ),
        false,
        "the independent checkout has no alternates",
      );
      assert.equal(
        await fixture.must(reviewCheckout, ["rev-parse", "HEAD"]),
        fixture.candidate,
        "exact candidate head",
      );
      assert.equal(
        await fixture.must(reviewCheckout, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]),
        "HEAD",
        "detached HEAD",
      );
      await fixture.must(reviewCheckout, [
        "cat-file",
        "-e",
        `${fixture.oldBase}^{commit}`,
      ]);
      const status = await fixture.git(reviewCheckout, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      assert.ok(status.ok, status.stderr);
      assert.equal(
        status.stdout.trim(),
        "",
        "clean tracked and untracked state",
      );
      const remotes = await fixture.git(reviewCheckout, ["remote"]);
      assert.equal(remotes.stdout.trim(), "", "no transport authority remains");
      const config = await fixture.git(reviewCheckout, [
        "config",
        "--local",
        "--list",
      ]);
      assert.equal(config.stdout.includes("remote."), false);
      assert.equal(config.stdout.includes("credential"), false);
      assert.equal(config.stdout.includes("http."), false);

      // Verified reuse moves the SAME independent checkout to a new exact
      // head without recloning, resetting or cleaning anything.
      const second = await prepareReviewCheckout({
        sourcePath: fixture.source,
        reviewCheckout,
        base: fixture.oldBase as GitSha,
        head: fixture.newBase as GitSha,
        trustedPath: fixture.trustedPath,
        scratch: fixture.scratch,
      });
      assert.ok(second.ok, second.ok ? "" : second.error.detail);
      assert.equal(
        await fixture.must(reviewCheckout, ["rev-parse", "HEAD"]),
        fixture.newBase,
      );
      assert.equal(
        await fixture.must(reviewCheckout, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]),
        "HEAD",
      );
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local review checkout: dirty, hostile and unowned directories are refused and preserved",
  async (t) => {
    const fixture = await checkoutFixture();
    try {
      const prepare = (reviewCheckout: string) =>
        prepareReviewCheckout({
          sourcePath: fixture.source,
          reviewCheckout,
          base: fixture.oldBase as GitSha,
          head: fixture.candidate as GitSha,
          trustedPath: fixture.trustedPath,
          scratch: fixture.scratch,
        });

      await t.step("unowned nonempty directory is preserved", async () => {
        const unowned = `${fixture.root}/unowned`;
        await Deno.mkdir(unowned, { recursive: true });
        await Deno.writeTextFile(`${unowned}/keep.txt`, "precious\n");
        const refused = await prepare(unowned);
        assert.equal(refused.ok, false);
        if (refused.ok) return;
        assert.equal(refused.error.kind, "unavailable");
        assert.equal(
          await Deno.readTextFile(`${unowned}/keep.txt`),
          "precious\n",
        );
      });

      await t.step("untracked work refuses reuse without erasure", async () => {
        const checkout = `${fixture.stateRoot}/review-dirty`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        await Deno.writeTextFile(`${checkout}/untracked.txt`, "work\n");
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await Deno.readTextFile(`${checkout}/untracked.txt`),
          "work\n",
        );
        assert.equal(
          await fixture.must(checkout, ["rev-parse", "HEAD"]),
          fixture.candidate,
        );
      });

      await t.step("alternates refuse reuse without erasure", async () => {
        const checkout = `${fixture.stateRoot}/review-alt`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        await Deno.mkdir(`${checkout}/.git/objects/info`, { recursive: true });
        await Deno.writeTextFile(
          `${checkout}/.git/objects/info/alternates`,
          `${fixture.source}/.git/objects\n`,
        );
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await localTestPathExists(
            `${checkout}/.git/objects/info/alternates`,
          ),
          true,
          "the alternates file is preserved, never silently removed",
        );
      });

      await t.step("credential config refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-config`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        await fixture.must(checkout, [
          "config",
          "--local",
          "credential.helper",
          "store",
        ]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        const config = await fixture.git(checkout, [
          "config",
          "--local",
          "--get",
          "credential.helper",
        ]);
        assert.equal(
          config.stdout.trim(),
          "store",
          "the unexpected config is preserved, never rewritten",
        );
      });

      await t.step(
        "unsafe local config keys refuse reuse without execution",
        async () => {
          const checkout = `${fixture.stateRoot}/review-unsafe-config`;
          const first = await prepare(checkout);
          assert.ok(first.ok, first.ok ? "" : first.error.detail);
          const sentinel = `${fixture.root}/executed-helper`;
          await fixture.must(checkout, [
            "config",
            "--local",
            "core.fsmonitor",
            sentinel,
          ]);
          await fixture.must(checkout, [
            "config",
            "--local",
            "filter.evil.smudge",
            `cat ${sentinel}`,
          ]);
          await fixture.must(checkout, [
            "config",
            "--local",
            "filter.evil.required",
            "true",
          ]);
          await fixture.must(checkout, [
            "config",
            "--local",
            "core.worktree",
            fixture.root,
          ]);
          const refused = await prepare(checkout);
          assert.equal(refused.ok, false);
          assert.equal(
            await localTestPathExists(sentinel),
            false,
            "no configured hook, fsmonitor or filter helper was executed",
          );
          const fsmonitor = await fixture.git(checkout, [
            "config",
            "--local",
            "--get",
            "core.fsmonitor",
          ]);
          assert.equal(
            fsmonitor.stdout.trim(),
            sentinel,
            "the unsafe config is preserved, never rewritten",
          );
          const worktree = await fixture.git(checkout, [
            "config",
            "--local",
            "--get",
            "core.worktree",
          ]);
          assert.equal(worktree.stdout.trim(), fixture.root);
        },
      );

      await t.step("commondir redirection refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-commondir`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const redirected = `${fixture.root}/redirected-git`;
        await Deno.mkdir(redirected, { recursive: true });
        await Deno.writeTextFile(
          `${checkout}/.git/commondir`,
          `${redirected}\n`,
        );
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await Deno.readTextFile(`${checkout}/.git/commondir`),
          `${redirected}\n`,
          "the commondir redirection is preserved, never removed",
        );
      });

      await t.step("symlinked critical metadata refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-symlink-config`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const config = `${checkout}/.git/config`;
        const realConfig = `${checkout}/.git/config.real`;
        await Deno.copyFile(config, realConfig);
        await Deno.remove(config);
        await localTestLink(["-s", realConfig, config]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        const info = await Deno.lstat(config);
        assert.ok(
          info.isSymlink,
          "the symlinked critical metadata is preserved, never followed",
        );
        assert.equal(
          await Deno.readTextFile(config),
          await Deno.readTextFile(realConfig),
        );
      });

      await t.step("grafts redirection refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-grafts`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const grafts = `${checkout}/.git/info/grafts`;
        await Deno.writeTextFile(grafts, `${fixture.oldBase}\n`);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await Deno.readTextFile(grafts),
          `${fixture.oldBase}\n`,
          "the grafts file is preserved, never removed",
        );
      });

      await t.step("loose replacement refs refuse reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-replace-loose`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const replacement = `refs/replace/${fixture.candidate}`;
        await fixture.must(checkout, [
          "update-ref",
          replacement,
          fixture.oldBase,
        ]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await fixture.must(checkout, ["rev-parse", replacement]),
          fixture.oldBase,
          "the loose replacement ref is preserved, never rewritten",
        );
        assert.equal(
          await localTestPathExists(`${checkout}/.git/${replacement}`),
          true,
          "the loose replacement ref file stays in place",
        );
        assert.equal(
          await fixture.must(checkout, ["rev-parse", "HEAD"]),
          fixture.candidate,
          "a refused reuse never moves HEAD",
        );
      });

      await t.step("packed replacement refs refuse reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-replace-packed`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const replacement = `refs/replace/${fixture.candidate}`;
        await fixture.must(checkout, [
          "update-ref",
          replacement,
          fixture.oldBase,
        ]);
        await fixture.must(checkout, ["pack-refs", "--all"]);
        assert.equal(
          await localTestPathExists(`${checkout}/.git/${replacement}`),
          false,
          "the replacement ref is packed, not loose",
        );
        assert.ok(
          (await Deno.readTextFile(`${checkout}/.git/packed-refs`)).includes(
            `${replacement}\n`,
          ),
          "packed-refs carries the replacement ref",
        );
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await fixture.must(checkout, ["rev-parse", replacement]),
          fixture.oldBase,
          "the packed replacement ref is preserved, never rewritten",
        );
        assert.equal(
          await fixture.must(checkout, ["rev-parse", "HEAD"]),
          fixture.candidate,
          "a refused reuse never moves HEAD",
        );
      });

      await t.step("symlinked FETCH_HEAD refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-link-fetch-head`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const offending = `${checkout}/.git/FETCH_HEAD`;
        const target = `${fixture.root}/fetch-head-target`;
        await Deno.writeTextFile(target, "fetch head target\n");
        if (await localTestPathExists(offending)) await Deno.remove(offending);
        await localTestLink(["-s", target, offending]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.ok(
          (await Deno.lstat(offending)).isSymlink,
          "the FETCH_HEAD symlink is preserved, never followed",
        );
        assert.equal(
          await Deno.readTextFile(target),
          "fetch head target\n",
          "the symlink target is preserved",
        );
      });

      await t.step("symlinked logs descendant refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-link-logs`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const logs = `${checkout}/.git/logs`;
        const offending = `${logs}/HEAD`;
        const target = `${fixture.root}/logs-head-target`;
        await Deno.writeTextFile(target, "logs head target\n");
        await Deno.mkdir(logs, { recursive: true });
        if (await localTestPathExists(offending)) await Deno.remove(offending);
        await localTestLink(["-s", target, offending]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.ok(
          (await Deno.lstat(offending)).isSymlink,
          "the logs descendant symlink is preserved, never followed",
        );
        assert.equal(
          await Deno.readTextFile(target),
          "logs head target\n",
          "the symlink target is preserved",
        );
      });

      await t.step("symlinked pack descendant refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-link-pack`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const pack = `${checkout}/.git/objects/pack`;
        const offending = `${pack}/sentinel-link.pack`;
        const target = `${fixture.root}/pack-target`;
        await Deno.writeTextFile(target, "pack target\n");
        await Deno.mkdir(pack, { recursive: true });
        await localTestLink(["-s", target, offending]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.ok(
          (await Deno.lstat(offending)).isSymlink,
          "the pack descendant symlink is preserved, never followed",
        );
        assert.equal(
          await Deno.readTextFile(target),
          "pack target\n",
          "the symlink target is preserved",
        );
      });

      await t.step("shared metadata file refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-hardlink`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const offending = `${checkout}/.git/FETCH_HEAD`;
        const target = `${fixture.root}/shared-metadata`;
        await Deno.writeTextFile(target, "shared metadata\n");
        if (await localTestPathExists(offending)) await Deno.remove(offending);
        await localTestLink([target, offending]);
        assert.equal(
          (await Deno.lstat(offending)).nlink,
          2,
          "the fixture metadata file shares one inode with its target",
        );
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await Deno.readTextFile(offending),
          "shared metadata\n",
          "the shared metadata file is preserved",
        );
        assert.equal(
          await Deno.readTextFile(target),
          "shared metadata\n",
          "the shared metadata target is preserved",
        );
        assert.equal(
          (await Deno.lstat(offending)).nlink,
          2,
          "the shared link survives the refusal",
        );
        assert.equal((await Deno.lstat(target)).nlink, 2);
      });

      await t.step("a non-directory review path is refused", async () => {
        const file = `${fixture.root}/review-file`;
        await Deno.writeTextFile(file, "not a checkout\n");
        const refused = await prepare(file);
        assert.equal(refused.ok, false);
        assert.equal(await Deno.readTextFile(file), "not a checkout\n");
      });
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);
