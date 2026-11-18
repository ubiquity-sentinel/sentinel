/**
 * The refused `actions/checkout` input is named by a closed code (log only):
 * the stored reason stays `unsupported:checkout_inputs`, and supported
 * inputs still plan. Synthetic workflows only.
 */
import assert from "node:assert/strict";
import {
  backupCiCheckoutInput,
  planBackupCiJob,
  readBackupCiWorkflow,
} from "../../ops/backup-ci-workflow-map.ts";

function workflow(withLines: string) {
  const text = [
    "name: ci",
    "on: [push, pull_request]",
    "jobs:",
    "  deno:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...(withLines === "" ? [] : ["        with:", withLines]),
    "      - run: deno test",
  ].join("\n");
  return readBackupCiWorkflow(
    ".github/workflows/ci.yml",
    "100644",
    new TextEncoder().encode(text),
  );
}

Deno.test("each refused checkout input has its closed code", () => {
  assert.equal(backupCiCheckoutInput(undefined), null);
  assert.equal(backupCiCheckoutInput({ "fetch-depth": 1 }), null);
  assert.equal(backupCiCheckoutInput({ "persist-credentials": false }), null);
  assert.equal(backupCiCheckoutInput({ "fetch-depth": 0 }), "fetch_depth");
  assert.equal(backupCiCheckoutInput({ submodules: true }), "submodules");
  assert.equal(backupCiCheckoutInput({ ref: "main" }), "ref");
  assert.equal(backupCiCheckoutInput({ path: "app" }), "path");
  assert.equal(backupCiCheckoutInput({ token: "x" }), "token");
  assert.equal(backupCiCheckoutInput({ "ssh-key": "x" }), "ssh_key");
  assert.equal(backupCiCheckoutInput({ "made-up": "x" }), "other");
  // Review probe P5: an inherited property name is not a closed code (it
  // returned the Object constructor function before).
  for (
    const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]
  ) {
    assert.equal(
      backupCiCheckoutInput(JSON.parse(`{"${key}":"x"}`)),
      "other",
      key,
    );
  }
});

Deno.test("a refused job never names an inherited property as its input", () => {
  const refused = planBackupCiJob(workflow("          constructor: x"), "deno");
  assert.deepEqual(refused, {
    ok: false,
    reason: "checkout_inputs",
    input: "other",
  });
});

Deno.test("a refused job names the input; the stored reason is unchanged", () => {
  const refused = planBackupCiJob(
    workflow("          fetch-depth: 0"),
    "deno",
  );
  assert.deepEqual(refused, {
    ok: false,
    reason: "checkout_inputs",
    input: "fetch_depth",
  });
  const planned = planBackupCiJob(workflow("          fetch-depth: 1"), "deno");
  assert.equal(planned.ok, true);
  const plain = planBackupCiJob(workflow(""), "deno");
  assert.equal(plain.ok, true);
});
