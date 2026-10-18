/** Advisory candidate / likely-infrastructure labels for failing checks. */
import assert from "node:assert/strict";
import { classifyCheck } from "../../src/repair/ci-evidence-classify.ts";
import { CiLogScanner } from "../../src/repair/ci-evidence-excerpt.ts";
import {
  type CiFixtureName,
  fixtureBytes,
  REAL_FIXTURES,
} from "./ci-evidence-fixtures.ts";

function log(name: CiFixtureName) {
  const scanner = new CiLogScanner();
  scanner.pushBytes(fixtureBytes(name));
  return scanner.finish();
}

const STEP = (name: string, conclusion = "failure", number = 11) => ({
  number,
  name,
  conclusion,
});

Deno.test("every live red ai.ubq.fi fixture is the candidate's: a repository command failed", () => {
  for (const name of REAL_FIXTURES) {
    const scanned = log(name);
    const label = classifyCheck({
      conclusion: "failure",
      external: false,
      failingSteps: [STEP("Complete Bun gates with the prepared binding")],
      log: scanned,
    });
    assert.equal(label.classification, "candidate", name);
    assert.equal(label.reason, "a repository command failed in a run step");
  }
});

Deno.test("setup, checkout, cache and artifact actions are likely infrastructure", () => {
  const checkout = classifyCheck({
    conclusion: "failure",
    external: false,
    failingSteps: [STEP("Run actions/checkout@v4", "failure", 2)],
    log: log("synthetic-infra-checkout.txt"),
  });
  assert.equal(checkout.classification, "likely_infrastructure");
  for (
    const name of [
      "Set up job",
      "Complete job",
      "Post Run actions/checkout@v4",
      "Run actions/setup-node@v4",
      "Run oven-sh/setup-bun@v2",
      "Run actions/cache@v4",
      "Run actions/upload-artifact@v4",
      "Checkout repository",
    ]
  ) {
    const label = classifyCheck({
      conclusion: "failure",
      external: false,
      failingSteps: [STEP(name, "failure", 1)],
      log: null,
    });
    assert.equal(label.classification, "likely_infrastructure", name);
  }
});

Deno.test("a failure in post-job cleanup after a passing run step is likely infrastructure", () => {
  const scanner = new CiLogScanner();
  scanner.pushText(
    "##[group]Run bun test\nshell: /usr/bin/bash -e {0}\n##[endgroup]\n" +
      "0 fail\nPost job cleanup.\n##[error]The process '/usr/bin/git' failed with exit code 128\n",
  );
  const label = classifyCheck({
    conclusion: "failure",
    external: false,
    failingSteps: [STEP("Post Run actions/checkout@v4", "failure", 14)],
    log: scanner.finish(),
  });
  assert.equal(label.classification, "likely_infrastructure");
});

Deno.test("candidate output imitating a checkout step cannot relabel a run-step failure", () => {
  const scanner = new CiLogScanner();
  scanner.pushText(
    "##[group]Run bun test\nshell: /usr/bin/bash -e {0}\n##[endgroup]\n" +
      "##[group]Run actions/checkout@v4\n##[endgroup]\n" +
      "##[error]fatal: unable to access the repository\n",
  );
  const label = classifyCheck({
    conclusion: "failure",
    external: false,
    failingSteps: [STEP("Run unit tests")],
    log: scanner.finish(),
  });
  assert.equal(label.classification, "candidate");
});

Deno.test("startup failures, lost runners and setup timeouts are likely infrastructure", () => {
  assert.equal(
    classifyCheck({
      conclusion: "startup_failure",
      external: false,
      failingSteps: [],
      log: null,
    }).classification,
    "likely_infrastructure",
  );
  assert.equal(
    classifyCheck({
      conclusion: "failure",
      external: false,
      failingSteps: [STEP("Run npm test")],
      log: log("synthetic-runner-lost.txt"),
    }).classification,
    "likely_infrastructure",
  );
  assert.equal(
    classifyCheck({
      conclusion: "timed_out",
      external: false,
      failingSteps: [STEP("Run actions/setup-node@v4", "cancelled", 2)],
      log: null,
    }).classification,
    "likely_infrastructure",
  );
});

Deno.test("a run step that times out is the candidate's (a possible hang)", () => {
  const label = classifyCheck({
    conclusion: "timed_out",
    external: false,
    failingSteps: [STEP("Run deno test --allow-net", "cancelled", 3)],
    log: log("synthetic-timeout-hang.txt"),
  });
  assert.equal(label.classification, "candidate");
  assert.match(label.reason, /hang/);
});

Deno.test("cancelled jobs are infrastructure unless a step itself failed", () => {
  assert.equal(
    classifyCheck({
      conclusion: "cancelled",
      external: false,
      failingSteps: [STEP("Run tests", "cancelled")],
      log: null,
    }).classification,
    "likely_infrastructure",
  );
  assert.equal(
    classifyCheck({
      conclusion: "cancelled",
      external: false,
      failingSteps: [STEP("Run tests", "failure")],
      log: null,
    }).classification,
    "candidate",
  );
});

Deno.test("external checks and missing step detail default to the candidate", () => {
  assert.equal(
    classifyCheck({
      conclusion: "failure",
      external: true,
      failingSteps: null,
      log: null,
    }).classification,
    "candidate",
  );
  for (const conclusion of ["cancelled", "stale"]) {
    assert.equal(
      classifyCheck({
        conclusion,
        external: true,
        failingSteps: null,
        log: null,
      }).classification,
      "likely_infrastructure",
    );
  }
  for (const failingSteps of [null, [], [STEP("Set up database fixtures")]]) {
    assert.equal(
      classifyCheck({
        conclusion: "failure",
        external: false,
        failingSteps,
        log: null,
      }).classification,
      "candidate",
    );
  }
});
