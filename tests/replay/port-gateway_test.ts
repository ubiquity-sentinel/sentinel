import assert from "node:assert/strict";
import { SENTINEL_REPLAY_INPUT_PATH } from "../../src/replay/causal-verifier.ts";
import { commitSymlink, commitWith, gitRun } from "./helpers.ts";
import { assertPortOk, text, withFixture } from "./port-helpers.ts";
import {
  commitGatewayCandidate,
  GATEWAY_DIR,
  GATEWAY_INCIDENT,
  GATEWAY_REQUEST_PATH,
  GATEWAY_REQUEST_TEXT,
  GATEWAY_TEST_ID,
  GATEWAY_TEST_ID_B,
  GATEWAY_UPSTREAM_PATH,
  GATEWAY_UPSTREAM_TEXT,
  gatewayBundle,
  gatewayDispatchText,
  gatewayPort,
  gatewayRequest,
  makeGatewayToy,
} from "./port-gateway-helpers.ts";

Deno.test(
  "gateway dispatch: fail-before/pass-after materializes the dispatcher for both replay and test commands",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest, ref } = await gatewayBundle();
        const port = gatewayPort(toy.root, `${root}/scratch`, bundle);

        // Original revision: the dispatcher is materialized OUTSIDE the
        // two-entry bundle and the committed consumer selects the exact
        // fixture through it; a missing dispatcher would exit 3 and could
        // never be an intended failure.
        const before = assertPortOk(
          await port.runReplay(
            gatewayRequest(bundle, ref, digest, toy.originalSha),
          ),
        );
        assert.equal(before.outcome, "failed");
        assert.equal(before.exitCode, 1);
        assert.equal(before.failure?.intended, true);
        assert.deepEqual(before.limitations, []);

        // Candidate revision: the two fixture entries are committed but the
        // dispatcher is NOT, so the passing regression depends on ReplayPort
        // materializing it — and the ordinary test command (not the replay
        // command) receives the same trusted metadata.
        const candidateSha = await commitGatewayCandidate(toy);
        const after = assertPortOk(
          await port.runReplay(
            gatewayRequest(bundle, ref, digest, candidateSha, {
              commandId: "test",
            }),
          ),
        );
        assert.equal(after.outcome, "passed");
        assert.equal(after.exitCode, 0);
        assert.deepEqual(after.limitations, []);

        // The shared source working directory is untouched.
        const status = await gitRun(
          toy.root,
          ["status", "--porcelain"],
          toy.env,
        );
        assert.equal(status.stdout.trim(), "");
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: a candidate that already carries the byte-identical dispatcher is accepted untouched",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest, ref } = await gatewayBundle();
        const candidateSha = await commitGatewayCandidate(toy, {
          [SENTINEL_REPLAY_INPUT_PATH]: gatewayDispatchText(),
        });
        const port = gatewayPort(toy.root, `${root}/scratch`, bundle);
        const after = assertPortOk(
          await port.runReplay(
            gatewayRequest(bundle, ref, digest, candidateSha, {
              commandId: "test",
            }),
          ),
        );
        assert.equal(after.outcome, "passed");
        assert.equal(after.exitCode, 0);
        assert.deepEqual(after.limitations, []);

        // The delivered bytes are exactly the canonical record, untouched by
        // the replay materialization.
        const committed = await gitRun(
          toy.root,
          ["show", `${candidateSha}:${SENTINEL_REPLAY_INPUT_PATH}`],
          toy.env,
        );
        assert.ok(committed.ok, `show failed: ${committed.stderr}`);
        assert.equal(committed.stdout, gatewayDispatchText());
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: foreign dispatcher bytes are rejected and never rewritten",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest, ref } = await gatewayBundle();
        const foreign = JSON.stringify({
          version: "v1",
          requestPath: "tests/elsewhere/request.json",
          upstreamPath: "tests/elsewhere/upstream.json",
          testIds: [GATEWAY_TEST_ID],
        });
        const candidateSha = await commitGatewayCandidate(toy, {
          [SENTINEL_REPLAY_INPUT_PATH]: foreign,
        });
        const result = await gatewayPort(
          toy.root,
          `${root}/scratch`,
          bundle,
        ).runReplay(
          gatewayRequest(bundle, ref, digest, candidateSha, {
            commandId: "test",
          }),
        );
        assert.ok(!result.ok, "foreign dispatcher bytes must fail closed");
        assert.equal(result.error.kind, "invalid");
        assert.match(result.error.detail, /different bytes/);
        assert.match(result.error.detail, /\.sentinel-replay-input\.json/);

        // The committed foreign bytes are unchanged (never rewritten).
        const committed = await gitRun(
          toy.root,
          ["show", `${candidateSha}:${SENTINEL_REPLAY_INPUT_PATH}`],
          toy.env,
        );
        assert.ok(committed.ok);
        assert.equal(committed.stdout, foreign);
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: symlinked and directory dispatcher targets are rejected",
  async () => {
    await withFixture(async (root) => {
      const { bundle, digest, ref } = await gatewayBundle();

      // A symlink AT the dispatcher path (committed as a gitlink entry).
      const linkToy = await makeGatewayToy(`${root}/toy-link`);
      try {
        const symlinkSha = await commitSymlink(
          linkToy.root,
          linkToy.env,
          SENTINEL_REPLAY_INPUT_PATH,
          "deno.json",
        );
        const asLink = await gatewayPort(
          linkToy.root,
          `${root}/scratch-link`,
          bundle,
        ).runReplay(gatewayRequest(bundle, ref, digest, symlinkSha));
        assert.ok(!asLink.ok, "symlinked dispatcher must fail closed");
        assert.equal(asLink.error.kind, "invalid");
        assert.match(asLink.error.detail, /resolves through a symlink/);
      } finally {
        await linkToy.cleanup();
      }

      // A directory at the dispatcher path (git cannot track an empty
      // directory, so it holds one file).
      const dirToy = await makeGatewayToy(`${root}/toy-dir`);
      try {
        const dirSha = await commitWith(dirToy.root, dirToy.env, {
          [`${SENTINEL_REPLAY_INPUT_PATH}/deeper.txt`]: "x",
        }, "gateway toy tamper: dispatcher target is a directory");
        const asDir = await gatewayPort(
          dirToy.root,
          `${root}/scratch-dir`,
          bundle,
        ).runReplay(gatewayRequest(bundle, ref, digest, dirSha));
        assert.ok(!asDir.ok, "directory dispatcher must fail closed");
        assert.equal(asDir.error.kind, "invalid");
        assert.match(asDir.error.detail, /is a directory/);
      } finally {
        await dirToy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: missing, ambiguous or extra gateway bundle entries are rejected",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const expected = {
          request: {
            path: GATEWAY_REQUEST_PATH,
            bytes: text.encode(GATEWAY_REQUEST_TEXT),
          },
          upstream: {
            path: GATEWAY_UPSTREAM_PATH,
            bytes: text.encode(GATEWAY_UPSTREAM_TEXT),
          },
        };

        // Extra entry (a third file in the gateway bundle).
        const extra = await gatewayBundle([GATEWAY_TEST_ID], [
          expected.request,
          expected.upstream,
          { path: `${GATEWAY_DIR}/extra.json`, bytes: text.encode("{}") },
        ]);
        const extraRun = await gatewayPort(
          toy.root,
          `${root}/scratch-extra`,
          extra.bundle,
        ).runReplay(
          gatewayRequest(
            extra.bundle,
            extra.ref,
            extra.digest,
            toy.originalSha,
          ),
        );
        assert.ok(!extraRun.ok, "an extra entry must fail closed");
        assert.equal(extraRun.error.kind, "invalid");
        assert.match(
          extraRun.error.detail,
          /exactly the fixed request and upstream entries/,
        );

        // Wrong capture directory: the two paths are not the resolved ones.
        const wrongDir = await gatewayBundle([GATEWAY_TEST_ID], [
          {
            path:
              `tests/fixtures/gateway-replay/${GATEWAY_INCIDENT}/other-capture/request.json`,
            bytes: text.encode(GATEWAY_REQUEST_TEXT),
          },
          expected.upstream,
        ]);
        const wrongDirRun = await gatewayPort(
          toy.root,
          `${root}/scratch-wrong-dir`,
          wrongDir.bundle,
        ).runReplay(
          gatewayRequest(
            wrongDir.bundle,
            wrongDir.ref,
            wrongDir.digest,
            toy.originalSha,
          ),
        );
        assert.ok(!wrongDirRun.ok, "wrong selected paths must fail closed");
        assert.equal(wrongDirRun.error.kind, "invalid");
        assert.match(
          wrongDirRun.error.detail,
          /exactly the fixed request and upstream entries/,
        );

        // Ambiguous (duplicate) entry path: rejected by the bundle validation
        // before any command can run.
        const duplicate = await gatewayBundle([GATEWAY_TEST_ID], [
          expected.request,
          expected.request,
        ]);
        const duplicateRun = await gatewayPort(
          toy.root,
          `${root}/scratch-duplicate`,
          duplicate.bundle,
        ).runReplay(
          gatewayRequest(
            duplicate.bundle,
            duplicate.ref,
            duplicate.digest,
            toy.originalSha,
          ),
        );
        assert.ok(!duplicateRun.ok, "an ambiguous entry must fail closed");
        assert.equal(duplicateRun.error.kind, "invalid");
        assert.match(duplicateRun.error.detail, /duplicate fixture entry path/);
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: a malformed reserved gateway reference is rejected instead of falling back",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest } = await gatewayBundle();
        // Reserved gateway references outside the frozen grammar: a capture id
        // containing a colon (allowed by the restricted-ref pattern but never
        // by the gateway identity grammar) and the bare reserved namespace
        // (no trailing slash or path).
        for (
          const malformedRef of [
            `fixture://gateway-replay/${GATEWAY_INCIDENT}/capture:broken/${digest}`,
            "fixture://gateway-replay",
          ]
        ) {
          const result = await gatewayPort(
            toy.root,
            `${root}/scratch`,
            bundle,
          ).runReplay(
            gatewayRequest(bundle, malformedRef, digest, toy.originalSha),
          );
          assert.ok(
            !result.ok,
            `reserved reference ${malformedRef} must fail closed`,
          );
          assert.equal(result.error.kind, "invalid");
          assert.match(
            result.error.detail,
            /malformed gateway fixture reference/,
          );
        }
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: metadata binds the trusted resolved ids and rejects a different id set",
  async () => {
    await withFixture(async (root) => {
      const resolvedIds = [GATEWAY_TEST_ID, GATEWAY_TEST_ID_B];
      const toy = await makeGatewayToy(`${root}/toy`, resolvedIds);
      try {
        const { bundle, digest, ref } = await gatewayBundle(resolvedIds);
        const candidateSha = await commitGatewayCandidate(toy);
        const port = gatewayPort(toy.root, `${root}/scratch`, bundle);

        // The request lists the same id SET in a different order: the
        // identity check is exact-set, and the metadata must bind the trusted
        // resolved order the committed consumer verifies.
        const reordered = assertPortOk(
          await port.runReplay(
            gatewayRequest(bundle, ref, digest, candidateSha, {
              commandId: "test",
              testIds: [GATEWAY_TEST_ID_B, GATEWAY_TEST_ID],
            }),
          ),
        );
        assert.equal(reordered.outcome, "passed");
        assert.equal(reordered.exitCode, 0);

        // A request whose id set differs from the resolved identity is
        // rejected before any command runs.
        const mismatched = await port.runReplay(
          gatewayRequest(bundle, ref, digest, candidateSha, {
            testIds: [GATEWAY_TEST_ID],
          }),
        );
        assert.ok(!mismatched.ok, "a different id set must fail closed");
        assert.equal(mismatched.error.kind, "invalid");
        assert.match(mismatched.error.detail, /test identity/);
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: non-gateway references are unchanged and receive no dispatcher",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest } = await gatewayBundle();
        // The same gateway-shaped bundle under a non-gateway reference: no
        // dispatcher is materialized, so the metadata-reading consumer exits
        // without the trusted marker and the run is never an intended
        // regression.
        const nonGatewayRef = "fixture://captures/toy/gateway.json";
        const run = assertPortOk(
          await gatewayPort(toy.root, `${root}/scratch`, bundle).runReplay(
            gatewayRequest(bundle, nonGatewayRef, digest, toy.originalSha),
          ),
        );
        assert.equal(run.outcome, "failed");
        assert.equal(run.failure?.intended, false);
      } finally {
        await toy.cleanup();
      }
    });
  },
);
