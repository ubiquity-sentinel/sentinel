import assert from "node:assert/strict";
import {
  nativeCiAggregateStatus,
  runNativeCiWrapper,
} from "../../ops/native-ci-proof.ts";
import {
  NATIVE_CI_MARKER,
  parseNativeCiProof,
} from "../../src/contracts/native-ci.ts";
import { SHA1, SHA2, SHA3 } from "../github/helpers.ts";

Deno.test("native CI aggregate: every prerequisite must exist and complete successfully", () => {
  const successful = {
    quality: { result: "success", outputs: {} },
    "test-shards": { result: "success", outputs: {} },
  };
  assert.equal(nativeCiAggregateStatus(successful), 0);
  for (const name of Object.keys(successful)) {
    for (const result of ["failure", "cancelled", "skipped", "", null]) {
      assert.equal(
        nativeCiAggregateStatus({ ...successful, [name]: { result } }),
        1,
      );
    }
    const missing = { ...successful } as Record<string, unknown>;
    delete missing[name];
    assert.equal(nativeCiAggregateStatus(missing), 1);
  }
  for (const value of [null, [], {}, "success", { ...successful, extra: {} }]) {
    assert.equal(nativeCiAggregateStatus(value), 1);
  }
});

Deno.test("native CI wrapper: emits immutable tested checkout only after a successful hermetic harness", async (t) => {
  for (const mode of ["success", "failed", "changed", "push"] as const) {
    await t.step(mode, async () => {
      const output: string[] = [];
      let ran = false;
      const env: Record<string, string> = {
        GITHUB_EVENT_NAME: mode === "push" ? "push" : "pull_request",
        GITHUB_REPOSITORY: "Ubiquity-Sentinel/sentinel",
        GITHUB_EVENT_PATH: "/synthetic/event.json",
        GITHUB_RUN_ID: "500",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW_SHA: SHA1,
      };
      const call = () =>
        runNativeCiWrapper({
          env: (name) => env[name],
          readEvent: () =>
            Promise.resolve(
              JSON.stringify({
                repository: { id: 17 },
                number: 1,
                pull_request: {
                  head: { sha: SHA1, ref: "sentinel/fix-1" },
                  base: { sha: SHA2 },
                },
              }),
            ),
          git: (args) =>
            Promise.resolve(
              args[1] === "HEAD"
                ? (ran && mode === "changed" ? SHA2 : SHA1)
                : args[1] === "HEAD^{tree}"
                ? SHA3
                : SHA2,
            ),
          harness: () => {
            ran = true;
            return Promise.resolve(mode === "failed" ? 1 : 0);
          },
          emit: (line) => output.push(line),
        });
      if (mode === "changed") await assert.rejects(call, /checkout changed/);
      else {
        const result = await call();
        assert.equal(result, mode === "failed" ? 1 : 0);
      }
      assert.equal(output.length, mode === "success" ? 1 : 0);
      if (output.length === 1) {
        assert.ok(output[0].startsWith(NATIVE_CI_MARKER));
        const proof = parseNativeCiProof(
          JSON.parse(output[0].slice(NATIVE_CI_MARKER.length)),
        );
        assert.equal(proof.testedCommit, SHA1);
        assert.equal(proof.testedTree, SHA3);
      }
    });
  }
});
