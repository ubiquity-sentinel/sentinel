import assert from "node:assert/strict";
import {
  composeLocalGitHub,
  ensureReviewClient,
  finalizeLocalModelResult,
  localCheckoutKey,
  LocalCheckoutModelPort,
  type LocalModelInputV1,
  LocalSessionTracker,
} from "../../src/host/local.ts";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import {
  type GitHubCooldownGateV1,
  type ModelRunReceiptV1,
  type ModelRunRequestV1,
  portError,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import {
  GATEWAY_BASE_URL,
  type ModelRouteV1,
} from "../../src/host/model-route.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import {
  gitRun,
  makeRemoteCtx,
  SHA1,
  SHA3,
  T0,
  testGitEnv,
} from "../state/helpers.ts";
import {
  captureConsoleLog,
  DUMMY_RAW_ERROR,
  modelRequest,
  receipt,
} from "./local-test-helpers.ts";
import type { CodexStructuredReviewer } from "../../src/github/codex-reviewer.ts";
import {
  prepareRequest,
  ScriptedCodexSession,
  snapshotFixture,
} from "../github/codex-reviewer-helpers.ts";

Deno.test(
  "local receipt finalization: a trusted completed receipt survives a failed import",
  async () => {
    const captured = captureConsoleLog();
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-finalize-",
    });
    try {
      const request = modelRequest();
      const original = receipt();
      assert.equal(original.ok, true);
      const key = await localCheckoutKey(request.taskId);
      const checkout = `${stateRoot}/checkouts/${key}`;
      await Deno.mkdir(checkout, { recursive: true });
      await Deno.writeTextFile(`${checkout}/keep.txt`, "keep\n");
      let imports = 0;
      const result = await finalizeLocalModelResult({
        stateRoot,
        request,
        result: original,
        observedAt: T0,
        importCandidate: () => {
          imports++;
          return Promise.resolve(false);
        },
      });
      assert.deepEqual(
        result,
        original,
        "the exact original trusted receipt is returned unchanged",
      );
      assert.equal(imports, 1);
      assert.equal(
        (await Deno.stat(`${checkout}/keep.txt`)).isFile,
        true,
        "the persistent producer checkout is preserved",
      );
      // The existing diagnostic path still saved the private minimal receipt,
      // including the exact candidate head; no publication happened here.
      const resultsDir = `${stateRoot}/model-results/${key}`;
      const files = [...Deno.readDirSync(resultsDir)];
      assert.equal(files.length, 1);
      const written = await Deno.readTextFile(
        `${resultsDir}/${files[0]!.name}`,
      );
      assert.equal(written.includes(SHA3), true);
      assert.equal(written.includes("thread-1"), true);
      assert.equal(captured.lines.length, 1);
      const advisory = JSON.parse(captured.lines[0]!) as Record<
        string,
        unknown
      >;
      assert.equal(advisory.candidatePresent, true);
    } finally {
      captured.restore();
      await Deno.remove(stateRoot, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local receipt finalization: a diagnostic write failure keeps the completed receipt",
  async () => {
    const captured = captureConsoleLog();
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-finalize-failure-",
    });
    try {
      // A plain file where the model-results directory belongs forces the
      // private diagnostic write to fail through the existing path.
      await Deno.writeTextFile(`${stateRoot}/model-results`, "occupied\n");
      const request = modelRequest();
      const original = receipt();
      let imports = 0;
      const result = await finalizeLocalModelResult({
        stateRoot,
        request,
        result: original,
        observedAt: T0,
        importCandidate: () => {
          imports++;
          return Promise.resolve(false);
        },
      });
      assert.deepEqual(
        result,
        original,
        "the trusted completed receipt is never rewritten as unavailable",
      );
      assert.equal(
        imports,
        0,
        "an unsaved diagnostic never imports or publishes a candidate",
      );
      assert.equal(captured.lines.length, 1);
      assert.equal(
        captured.lines[0]!.includes("trusted completed receipt is preserved"),
        true,
        "the static diagnostic failure is reported",
      );

      // Non-completed port errors keep the original conservative behavior.
      const failure: PortResultV1<ModelRunReceiptV1> = {
        ok: false,
        error: { kind: "unavailable", detail: DUMMY_RAW_ERROR },
      };
      const conservative = await finalizeLocalModelResult({
        stateRoot,
        request,
        result: failure,
        observedAt: T0,
        importCandidate: () => {
          imports++;
          return Promise.resolve(false);
        },
      });
      assert.equal(conservative.ok, false);
      assert.equal(
        conservative.ok ? null : conservative.error.kind,
        "unavailable",
      );
      assert.equal(
        conservative.ok
          ? null
          : conservative.error.detail.includes(DUMMY_RAW_ERROR),
        false,
      );
      assert.equal(imports, 0);
      assert.equal(captured.lines.length, 1);
    } finally {
      captured.restore();
      await Deno.remove(stateRoot, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local host: checkout failures emit a sanitized model diagnostic",
  async () => {
    // REGRESSION: the two VALID-request checkout failure exits (candidate
    // restoration and checkout preparation) must use the same finalized
    // persistence/diagnostic path as any other failed run. On the old code
    // they returned STATIC_CHECKOUT directly: nothing persisted, nothing
    // emitted, and the fixed launcher decoder had no model_checkout_unavailable
    // record to read.
    const captured = captureConsoleLog();
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-checkout-diagnostic-",
    });
    try {
      const request = modelRequest();
      const key = await localCheckoutKey(request.taskId);
      const port = (input: Partial<LocalModelInputV1> = {}) =>
        new LocalCheckoutModelPort({
          stateRoot,
          sourcePath: `${stateRoot}/source.git`,
          scratch: `${stateRoot}/scratch`,
          trustedPath: `${stateRoot}/trusted`,
          // Never reached: without a prepared checkout no session can launch.
          codexExecutable: "/nonexistent/sentinel-codex-marker",
          denoExecutable: "/nonexistent/sentinel-deno-marker",
          modelToken: "dummy-model-token-marker",
          tracker: new LocalSessionTracker(),
          clock: new FakeClock(T0),
          ...input,
        });
      let restorationCalls = 0;
      const thrown = await port({
        ensureCandidateObjects: () => {
          restorationCalls++;
          return Promise.reject(new Error(DUMMY_RAW_ERROR));
        },
      }).runModel({ ...request, checkoutBase: SHA3 });
      const refused = await port({
        ensureCandidateObjects: (): Promise<PortResultV1<void>> => {
          restorationCalls++;
          return Promise.resolve(portError("unavailable", DUMMY_RAW_ERROR));
        },
      }).runModel({ ...request, checkoutBase: SHA3 });
      // No checkout was prepared for either restoration refusal.
      let checkoutPrepared = false;
      try {
        await Deno.stat(`${stateRoot}/checkouts`);
        checkoutPrepared = true;
      } catch {
        checkoutPrepared = false;
      }
      assert.equal(checkoutPrepared, false, "no checkout, so no launch");

      // Second early path: a VALID request refused by checkout preparation
      // (a stale mapping without its checkout) also fails before any start.
      await Deno.mkdir(`${stateRoot}/checkouts`, { recursive: true });
      await Deno.writeTextFile(`${stateRoot}/checkouts/${key}.json`, "{}\n");
      const unprepared = await port().runModel(request);
      assert.equal(restorationCalls, 2, "both restoration seams were used");
      checkoutPrepared = false;
      try {
        await Deno.stat(`${stateRoot}/checkouts/${key}`);
        checkoutPrepared = true;
      } catch {
        checkoutPrepared = false;
      }
      assert.equal(checkoutPrepared, false, "no checkout, so no launch");

      // The original unavailable checkout failure is preserved, unchanged and
      // without any raw seam text.
      const failures = [thrown, refused, unprepared].filter((result) =>
        !result.ok
      );
      assert.equal(failures.length, 3);
      const firstDetail = thrown.ok ? null : thrown.error.detail;
      assert.equal(typeof firstDetail, "string");
      for (const failure of failures) {
        if (failure.ok) continue;
        assert.equal(failure.error.kind, "unavailable");
        assert.equal(failure.error.detail, firstDetail);
        assert.equal(failure.error.detail.includes(DUMMY_RAW_ERROR), false);
      }

      // Exactly one advisory per failure, carrying only the whitelisted static
      // checkout reason code.
      assert.equal(captured.lines.length, 3, "one diagnostic per failure");
      for (const line of captured.lines) {
        const advisory = JSON.parse(line) as Record<string, unknown>;
        assert.equal(advisory.kind, "sentinel_model_diagnostic");
        assert.equal(advisory.taskKey, key);
        assert.equal(advisory.base, SHA1);
        assert.equal(advisory.outcome, "port_error");
        assert.equal(advisory.reasonCode, "model_checkout_unavailable");
        assert.equal(advisory.candidatePresent, false);
        assert.equal(line.includes(DUMMY_RAW_ERROR), false);
      }

      // The private model-result projection was actually persisted for the
      // same failures.
      const resultsDir = `${stateRoot}/model-results/${key}`;
      const files = [...Deno.readDirSync(resultsDir)];
      assert.equal(files.length, 3);
      for (const file of files) {
        const text = await Deno.readTextFile(`${resultsDir}/${file.name}`);
        const privateResult = JSON.parse(text) as Record<string, unknown>;
        assert.equal(privateResult.kind, "local_model_result");
        assert.equal(privateResult.reason, "runtime_error");
        const result = privateResult.result as Record<string, unknown>;
        assert.equal(result.ok, false);
        assert.equal(result.errorKind, "unavailable");
        assert.equal(text.includes(DUMMY_RAW_ERROR), false);
      }
    } finally {
      captured.restore();
      await Deno.remove(stateRoot, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local host: a base missing from the target mirror is fetched before the model checkout",
  async () => {
    // A run fetches its mirrors when a target cycle starts; the target branch
    // can move while that cycle is still running, and an intake record pinned
    // to the moved head then cannot be checked out. The exact base object is
    // ensured through the host seam before any checkout is prepared, and a
    // missing base with no seam still refuses the start.
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".", prefix: "sentinel-base-fetch-" }),
    );
    const home = `${root}/home`;
    await Deno.mkdir(home, { recursive: true });
    const env = testGitEnv(home);
    const trustedPath = env.PATH ?? "/usr/bin:/bin";
    try {
      const remote = await makeRemoteCtx(root, env);
      const commit = async (name: string): Promise<GitSha> => {
        await Deno.writeTextFile(`${remote.work}/${name}`, `${name}\n`);
        assert.equal(
          (await gitRun(remote.work, ["add", "-A"], env)).ok,
          true,
        );
        assert.equal(
          (await gitRun(
            remote.work,
            ["commit", "-q", "-m", name],
            env,
          )).ok,
          true,
        );
        assert.equal(
          (await gitRun(
            remote.work,
            ["push", "-q", "origin", "HEAD:refs/heads/development"],
            env,
          )).ok,
          true,
        );
        return (await gitRun(remote.work, ["rev-parse", "HEAD"], env))
          .stdout.trim() as GitSha;
      };
      const baseA = await commit("a.txt");
      const baseB = await commit("b.txt");
      // The mirror holds exactly the base that existed when the run fetched
      // it, and no object of the newer base at all.
      const mirror = `${root}/mirror.git`;
      assert.equal(
        (await gitRun(root, ["init", "-q", "--bare", mirror], env)).ok,
        true,
      );
      assert.equal(
        (await gitRun(
          remote.work,
          ["push", "-q", mirror, `${baseA}:refs/heads/development`],
          env,
        )).ok,
        true,
      );
      assert.notEqual(
        (await gitRun(mirror, ["cat-file", "-e", `${baseB}^{commit}`], env))
          .code,
        0,
        "the mirror starts without the newer base",
      );

      const stateRoot = `${root}/state`;
      const hostFetch = (): Promise<PortResultV1<void>> =>
        gitRun(
          mirror,
          [
            "fetch",
            "--no-tags",
            remote.remoteUrl,
            "+refs/heads/development:refs/remotes/origin/development",
          ],
          env,
        ).then((fetched) =>
          fetched.ok
            ? portOk(undefined)
            : portError("unavailable", "test base fetch failed")
        );
      const port = (input: Partial<LocalModelInputV1> = {}) =>
        new LocalCheckoutModelPort({
          stateRoot,
          sourcePath: mirror,
          scratch: home,
          trustedPath,
          // Never reached here: this case proves the checkout stage only.
          codexExecutable: "/nonexistent/sentinel-codex-marker",
          denoExecutable: "/nonexistent/sentinel-deno-marker",
          modelToken: "dummy-model-token-marker",
          tracker: new LocalSessionTracker(),
          clock: new FakeClock(T0),
          ...input,
        });
      const requestFor = (
        taskId: string,
        base: GitSha,
      ): ModelRunRequestV1 => ({
        ...modelRequest(),
        taskId: asWorkItemId(taskId),
        base,
      });

      // 1. The newer base is fetched exactly once through the host seam, and
      // the exact checkout is then prepared and detached at that base.
      let baseFetches = 0;
      const fetched = await port({
        ensureBaseObject: () => {
          baseFetches++;
          return hostFetch();
        },
      }).runModel(requestFor("issue-1", baseB));
      assert.equal(baseFetches, 1, "the host fetched the missing base once");
      assert.equal(fetched.ok, false, "no session can launch in this case");
      const firstKey = await localCheckoutKey(asWorkItemId("issue-1"));
      const firstCheckout = `${stateRoot}/checkouts/${firstKey}`;
      assert.equal(
        (await gitRun(firstCheckout, ["rev-parse", "HEAD"], env)).stdout.trim(),
        baseB,
        "the checkout is detached at the fetched base",
      );

      // 2. A second task at the same base reuses the mirror object and never
      // asks the host to fetch again.
      await port({
        ensureBaseObject: () => {
          baseFetches++;
          return hostFetch();
        },
      }).runModel(requestFor("issue-2", baseB));
      assert.equal(baseFetches, 1, "a present base is never fetched again");

      // 3. Fail closed without the host seam: a base absent from the mirror
      // refuses the start and prepares no checkout at all.
      const baseC = await commit("c.txt");
      const refused = await port().runModel(requestFor("issue-3", baseC));
      assert.equal(refused.ok, false);
      const thirdKey = await localCheckoutKey(asWorkItemId("issue-3"));
      let checkoutPrepared = false;
      try {
        await Deno.stat(`${stateRoot}/checkouts/${thirdKey}`);
        checkoutPrepared = true;
      } catch {
        checkoutPrepared = false;
      }
      assert.equal(checkoutPrepared, false, "no checkout without the base");
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local composition leaves native reviewer selection to Codex for every implementation route",
  async () => {
    const configuredRoute: ModelRouteV1 = {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      reasoning: "max",
      apiKeyEnv: "SENTINEL_DEEPSEEK_API_KEY",
      failoverModel: "gpt-6-luna",
    };
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".", prefix: "sentinel-review-model-" }),
    );
    try {
      for (
        const dir of [
          "state",
          "source",
          "scratch",
          "review",
          "clients",
          "tmp",
          "deno",
        ]
      ) {
        await Deno.mkdir(`${root}/${dir}`, { recursive: true });
      }
      const gate: GitHubCooldownGateV1 = {
        beforeRequest: () => Promise.resolve(portOk(undefined)),
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      };
      const http: HttpTransportV1 = () =>
        Promise.reject(new Error("no request in this composition test"));
      const compose = (route?: ModelRouteV1, reviewModelId?: string) =>
        composeLocalGitHub({
          clock: new FakeClock(T0),
          state: new MemoryState(),
          gate,
          http,
          token: "dummy-token",
          login: "ubiquity-sentinel[bot]",
          invocationId: "configured-review-model",
          stateRoot: `${root}/state`,
          sourcePath: `${root}/source`,
          scratch: `${root}/scratch`,
          reviewCheckout: `${root}/review`,
          reviewClientHome: `${root}/clients`,
          reviewTmpDir: `${root}/tmp`,
          reviewDenoDir: `${root}/deno`,
          trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          codexExecutable: "/usr/bin/false",
          tracker: new LocalSessionTracker(),
          route,
          reviewModelId,
        });
      // Replace only the transport of the actual composed reviewer. No model
      // call or credential is needed to inspect its native protocol request.
      const reviewerOf = (port: ReturnType<typeof composeLocalGitHub>) =>
        (port as unknown as {
          reviewService: {
            reviewer: {
              openSession: () => ScriptedCodexSession;
              prepare: CodexStructuredReviewer["prepare"];
            };
          };
        }).reviewService.reviewer;

      const ports = [
        compose(configuredRoute, "codex-auto-review"),
        compose(configuredRoute),
        compose(configuredRoute, " bad "),
        compose(),
      ];
      const snapshot = await snapshotFixture();
      for (const port of ports) {
        const reviewer = reviewerOf(port);
        const session = new ScriptedCodexSession();
        session.turnFailure = true;
        reviewer.openSession = () => session;
        const prepared = await reviewer.prepare(prepareRequest(snapshot));
        assert(prepared.ok, JSON.stringify(prepared));
        try {
          const result = await prepared.value.start();
          assert(!result.ok, "synthetic transport refuses paid execution");
          assert.equal(session.turnStarts(), 1);
          assert(!session.sent.includes("turn/start"));
          const thread = session.params[session.sent.indexOf("thread/start")];
          const native = session.params[session.sent.indexOf("review/start")];
          for (const params of [thread, native] as Record<string, unknown>[]) {
            for (
              const key of [
                "model",
                "modelProvider",
                "provider",
                "effort",
                "reasoningEffort",
                "review_model",
              ]
            ) assert(!Object.hasOwn(params, key), key);
            assert(
              !Object.hasOwn(
                (params.config ?? {}) as Record<string, unknown>,
                "review_model",
              ),
            );
          }
          assert.equal(
            (thread as Record<string, unknown>).permissions,
            "sentinel-review",
          );
        } finally {
          assert((await prepared.value.close()).settled);
        }
      }
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "review client is always gateway-bound, independent of the implementation route",
  async () => {
    // The CI harness grants read access to the repo directory (and a few
    // system paths) but not to the system temp dir, so the fixture lives
    // under the working directory like the other tests in this file.
    const root = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-review-client-",
    });
    try {
      // The hosted call site binds the review client to the gateway endpoint
      // with the gateway token; the implementation route is never passed.
      await ensureReviewClient({
        reviewCheckout: `${root}/checkout`,
        reviewClientHome: `${root}/home`,
        reviewTmpDir: `${root}/tmp`,
        reviewDenoDir: `${root}/deno`,
        token: "gateway-token",
        codexExecutable: "/usr/local/bin/codex",
        denoExecutable: "/usr/local/bin/deno",
        trustedPath: "/usr/bin:/bin",
        baseUrl: GATEWAY_BASE_URL,
      });
      const config = await Deno.readTextFile(`${root}/home/config.toml`);
      assert.match(config, /model_provider = "uos"/);
      assert.match(config, /\[model_providers\.uos\]/);
      assert.ok(
        config.includes(`base_url = "${GATEWAY_BASE_URL}"`),
        "review client points at the gateway endpoint",
      );
      // No implementation-route provider can leak into the review config.
      assert.doesNotMatch(config, /deepseek/);
      const token = await Deno.readTextFile(`${root}/home/model.token`);
      assert.equal(token, "gateway-token");

      // Omitted callers keep the loopback gateway default with the gateway
      // provider: the local path never inherits a foreign route either.
      await ensureReviewClient({
        reviewCheckout: `${root}/checkout2`,
        reviewClientHome: `${root}/home2`,
        reviewTmpDir: `${root}/tmp2`,
        reviewDenoDir: `${root}/deno2`,
        token: "gateway-token",
        codexExecutable: "/usr/local/bin/codex",
        denoExecutable: "/usr/local/bin/deno",
        trustedPath: "/usr/bin:/bin",
      });
      const localConfig = await Deno.readTextFile(`${root}/home2/config.toml`);
      assert.match(localConfig, /model_provider = "uos"/);
      assert.doesNotMatch(localConfig, /deepseek/);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);
