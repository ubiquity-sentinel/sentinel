import assert from "node:assert/strict";
import { parseNativeCiProof } from "../../src/contracts/native-ci.ts";
import { parseIntent } from "../../src/contracts/work-record-intent.ts";
import { parseTarget } from "../../src/contracts/work-record-target.ts";
import { SHA1, SHA2, SHA3 } from "../github/helpers.ts";

Deno.test("self merge contracts: legacy absence round-trips without injecting proof or receipt", () => {
  const intent = {
    kind: "merge",
    key: `merge:1:${SHA1}`,
    startedAt: 1786000000000,
    branch: "sentinel/fix-1",
    expectedHead: SHA1,
    observedBase: SHA2,
    pr: 1,
    requestId: "req-1",
    resultId: "result-9",
  };
  const target = {
    base: SHA2,
    branch: "sentinel/fix-1",
    checkpoint: null,
    head: SHA1,
    pr: 1,
  };
  assert.deepEqual(parseIntent(intent, "$"), intent);
  assert.deepEqual(parseTarget(target, "$"), target);
  assert.equal(Object.hasOwn(parseIntent(intent, "$"), "selfMerge"), false);
  assert.equal(Object.hasOwn(parseTarget(target, "$"), "selfMerge"), false);
});
Deno.test("native CI contracts: complete bounded facts and unknown-key refusal", () => {
  const proof = {
    version: "v1",
    repository: "ubiquity-sentinel/sentinel",
    repositoryId: 17,
    runId: 500,
    attempt: 1,
    job: "test-local",
    pr: 1,
    headRef: "sentinel/fix-1",
    head: SHA1,
    base: SHA2,
    testedCommit: SHA1,
    testedTree: SHA3,
    workflowSource: SHA2,
    sources: { workflow: SHA1, harness: SHA2, emitter: SHA3 },
  };
  assert.deepEqual(parseNativeCiProof(proof), proof);
  assert.throws(() => parseNativeCiProof({ ...proof, modelAuthority: true }));
  assert.throws(() => parseNativeCiProof({ ...proof, attempt: 0 }));
  assert.throws(() =>
    parseNativeCiProof({
      ...proof,
      sources: { ...proof.sources, injected: SHA1 },
    })
  );
});
