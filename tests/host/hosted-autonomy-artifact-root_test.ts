import assert from "node:assert/strict";
import { sep } from "node:path";
import { runHostedAutonomyMain } from "../../ops/hosted-autonomy-main.ts";
import { portError } from "../../src/contracts/ports.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { snapshotWire } from "../github/merge-queue-fixtures.ts";
import { nativeWriterFixture } from "./existing-pr-runtime-fixtures.ts";
import { futureRecoveryFixture } from "./owner-install-future-recovery-fixtures.ts";

Deno.test("hosted maintenance artifact root: production allocation passes completion isolation and is cleaned on success and failure", async (t) => {
  for (const failure of [false, true]) {
    await t.step(failure ? "failure" : "success", async () => {
      const rig = await futureRecoveryFixture({ legacyFirst: true });
      const original = {
        temp: Deno.makeTempDir,
        write: Deno.writeTextFile,
        env: Deno.env.get,
        fetch: globalThis.fetch,
      };
      let root: string | null = null;
      let completionStateReads = 0;
      let completionHttpReads = 0;
      let injectedFailure = false;
      const checkout = await Deno.realPath(rig.source.launcher);
      const output = `${rig.source.root}/production-maintenance-output`;
      const native = nativeWriterFixture(rig.run, "maintenance");
      const releaseBefore = await rig.current();
      const repairBefore = await rig.repair.readRepair();
      try {
        Deno.env.get = (key) =>
          key === "GITHUB_JOB"
            ? "maintenance"
            : key === "GITHUB_OUTPUT"
            ? output
            : original.env(key);
        globalThis.fetch = async (request, init) => {
          const url = new URL(
            request instanceof Request ? request.url : String(request),
          );
          assert.equal(url.origin, "https://api.github.com");
          if (url.pathname.includes("/rules/branches/")) {
            assert.equal(init?.method ?? "GET", "GET");
            return new Response("[]");
          }
          if (url.pathname === "/graphql") {
            assert.ok(
              JSON.parse(String(init?.body)).query.trimStart().startsWith(
                "query",
              ),
            );
            return new Response(JSON.stringify(snapshotWire(null)));
          }
          if (
            url.pathname.includes("/actions/") ||
            url.pathname.includes("/git/ref/")
          ) {
            return new Response(
              JSON.stringify(await native.read(url.pathname + url.search)),
            );
          }
          return await original.fetch(request, init);
        };
        // Observe the real production allocation; do not supply main's injected
        // deps branch or substitute another path for the completion consumer.
        Deno.makeTempDir = async (options) => {
          // Model host temp inside the declared test read scope. An explicit
          // production dir is preserved, so the old nested root still fails.
          const path = await original.temp(
            options?.prefix === "sentinel-maintenance-matrix-" &&
              options.dir === undefined
              ? { ...options, dir: rig.source.root }
              : options,
          );
          if (options?.prefix !== "sentinel-maintenance-matrix-") return path;
          root = path;
          const info = await Deno.stat(path);
          if (info.mode !== null) assert.equal(info.mode & 0o777, 0o700);
          const read = () => {
            completionStateReads++;
            return Promise.resolve(
              portError("unavailable", "fixture state boundary"),
            );
          };
          const transport = createActionsMatrixArtifactTransport({
            artifactRoot: path,
            token: "inert-completion-fixture",
            clock: { now: () => Date.now() },
            state: { readRepair: read, readRelease: read },
            http: () => {
              completionHttpReads++;
              throw new Error("completion fixture must stop before HTTP");
            },
          });
          await assert.rejects(
            () => transport.confirmCompletedExecution!(rig.healthy.execution),
            /matrix artifact provenance unavailable or conflicting/,
          );
          return path;
        };
        Deno.writeTextFile = async (path, data, options) => {
          if (failure && root !== null && path === output && !injectedFailure) {
            injectedFailure = true;
            throw new Error(
              "synthetic output failure after artifact allocation",
            );
          }
          await original.write(path, data, options);
        };
        const code = await runHostedAutonomyMain();
        assert.equal(code, 0);
        const terminal = rig.reports.findLast((row) =>
          row.kind === "hosted_autonomy"
        );
        assert.ok(terminal, "production main must report its actual outcome");
        assert.equal(
          terminal.reason === "deferred_unexpected_error",
          failure,
          JSON.stringify(terminal),
        );
        assert.notEqual(
          root,
          null,
          "real production branch must allocate recovery storage",
        );
        const allocated = String(root);
        assert.equal(
          allocated === checkout || allocated.startsWith(checkout + sep),
          false,
        );
        assert.equal(
          completionStateReads,
          2,
          "real completion transport must pass containment before reaching fake state",
        );
        assert.equal(completionHttpReads, 0);
        assert.equal(injectedFailure, failure);
        await assert.rejects(() => Deno.stat(allocated), Deno.errors.NotFound);
        assert.deepEqual(await rig.current(), releaseBefore);
        assert.deepEqual(await rig.repair.readRepair(), repairBefore);
        assert.equal(rig.patches(), 0);
      } finally {
        Deno.makeTempDir = original.temp;
        Deno.writeTextFile = original.write;
        Deno.env.get = original.env;
        globalThis.fetch = original.fetch;
        if (root !== null) {
          await Deno.remove(root, { recursive: true }).catch(() => {});
        }
        await rig.close();
      }
    });
  }
});

Deno.test("hosted maintenance artifact root: nested and symlink checkout roots still refuse before state or HTTP", async () => {
  const previous = Deno.cwd();
  const tmp = await Deno.makeTempDir({
    dir: previous,
    prefix: "maintenance-root-guards-",
  });
  const checkout = `${tmp}/checkout`;
  await Deno.mkdir(`${checkout}/nested`, { recursive: true });
  let reads = 0;
  const forbidden = () => {
    reads++;
    throw new Error("containment must precede all external reads");
  };
  try {
    const linked = await new Deno.Command("/bin/ln", {
      args: ["-s", `${checkout}/nested`, `${tmp}/link`],
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(
      linked.success,
      true,
      "task-local symlink fixture must be created",
    );
    Deno.chdir(checkout);
    for (const root of [`${checkout}/nested`, `${tmp}/link`]) {
      const transport = createActionsMatrixArtifactTransport({
        artifactRoot: root,
        token: "inert-completion-fixture",
        clock: { now: () => 1 },
        state: { readRepair: forbidden, readRelease: forbidden },
        http: forbidden,
      });
      await assert.rejects(
        () =>
          transport.confirmCompletedExecution!(parseHostedExecutionIntentV1({
            id: "1:1:repair",
            runId: 1,
            runAttempt: 1,
            launcherSha: "a".repeat(40),
            revision: "a".repeat(40),
            generation: 1,
            purpose: "ordinary",
            releaseId: null,
            createdAt: 1,
          })),
        /matrix artifact provenance unavailable or conflicting/,
      );
    }
    assert.equal(reads, 0);
  } finally {
    Deno.chdir(previous);
    await Deno.remove(tmp, { recursive: true });
  }
});
