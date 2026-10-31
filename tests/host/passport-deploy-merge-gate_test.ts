/**
 * Owner directive 2026-10-30: Passport's deployment workflows
 * (`deno-deploy.yml`, `workers-deploy.yml`) run only on `workflow_dispatch`
 * and report deployment checks (`deploy-production`, `deploy-standby`;
 * Cloudflare Pages/Workers statuses). They are deployment signals, not
 * correctness checks. The launcher's foreign merge gate must keep reading them
 * as evidence but must not let a pending or failed deploy check block a head
 * whose own CI jobs are green; a CI job that ran and failed stays red.
 *
 * The read is the real `createHostedAutonomyGitHub` surface over a scripted
 * transport; no network, credential, model or external write is used.
 */
import assert from "node:assert/strict";
import {
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import { reviewAuthorizesMerge } from "../../src/repair/review-gate.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy.ts";
import { headIsGreen } from "../../ops/hosted-autonomy-spent-delivery.ts";
import {
  authorizingReceipt,
  BASE,
  checkRun,
  checkRunPage,
  deliveryRecord,
  HEAD,
  jsonResponse,
} from "./hosted-autonomy-fixtures.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 155687488,
} as const;
const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 1,
} as const;

interface RunOptions {
  readonly headRuns: readonly unknown[];
  readonly baseRuns?: readonly unknown[];
}

/** Run `body` with `fetch` answering the complete check-run listing. */
async function withChecks<T>(
  options: RunOptions,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    const runs = options.baseRuns !== undefined &&
        url.includes(`/commits/${BASE}/check-runs`)
      ? options.baseRuns
      : options.headRuns;
    return Promise.resolve(
      jsonResponse(checkRunPage([...runs], runs.length)),
    );
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const GREEN_CI = checkRun("deno", { check_suite: { id: 11 } });
const FAILED_DEPLOY = checkRun("deploy-standby", {
  conclusion: "failure",
  check_suite: { id: 12 },
});
const BASE_GREEN_CI = checkRun("deno", {
  head_sha: BASE,
  check_suite: { id: 11 },
});
const BASE_FAILED_DEPLOY = checkRun("deploy-standby", {
  head_sha: BASE,
  conclusion: "failure",
  check_suite: { id: 12 },
});
const PENDING_DEPLOY = checkRun("deploy-production", {
  status: "in_progress",
  conclusion: null,
  check_suite: { id: 13 },
});
const FAILED_CI = checkRun("deno", {
  conclusion: "failure",
  check_suite: { id: 11 },
});

Deno.test("Passport deploy gate: a failed or pending deploy cannot block green CI", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", PASSPORT);
  assert.equal(
    await withChecks(
      { headRuns: [GREEN_CI, FAILED_DEPLOY, PENDING_DEPLOY] },
      () => surface.hasAllChecksGreen(HEAD),
    ),
    true,
  );
  assert.deepEqual(
    await withChecks(
      { headRuns: [GREEN_CI, FAILED_DEPLOY, PENDING_DEPLOY] },
      () => surface.failedChecks!(HEAD, ["failure"]),
    ),
    [],
    "a deploy failure is not a CI failure",
  );
  // The base tip carries its own deploy runs; the moved-base read must not
  // wait for them while the base's CI job is green.
  assert.equal(
    await withChecks(
      {
        headRuns: [GREEN_CI, FAILED_DEPLOY],
        baseRuns: [BASE_GREEN_CI, BASE_FAILED_DEPLOY],
      },
      () => surface.hasAllChecksGreen(HEAD, BASE),
    ),
    true,
  );
});

Deno.test("Passport deploy gate: a CI job that ran and failed is still red", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", PASSPORT);
  assert.equal(
    await withChecks(
      { headRuns: [FAILED_CI, checkRun("deploy-standby")] },
      () => surface.hasAllChecksGreen(HEAD),
    ),
    false,
  );
});

Deno.test("Passport deploy gate: deploy checks alone are no CI evidence", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", PASSPORT);
  assert.equal(
    await withChecks(
      { headRuns: [FAILED_DEPLOY, PENDING_DEPLOY] },
      () => surface.hasAllChecksGreen(HEAD),
    ),
    null,
  );
});

Deno.test("Passport deploy gate: every other target keeps every check as a gate", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  assert.equal(
    await withChecks(
      { headRuns: [GREEN_CI, FAILED_DEPLOY] },
      () => surface.hasAllChecksGreen(HEAD),
    ),
    false,
  );
});

Deno.test("Passport deploy gate: green CI plus a clean review merges despite a failed deploy", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", PASSPORT);
  const green = await withChecks(
    { headRuns: [GREEN_CI, FAILED_DEPLOY] },
    () => headIsGreen(surface, false, HEAD),
  );
  assert.equal(green, true, "the CI gate passes");
  const statement = {
    issueNumber: 58,
    title: "Repair the Passport deployment path",
    body: "Fix the product defect described by issue 58.",
  };
  const task: ReviewTaskStatementV1 = {
    ...statement,
    digest: await reviewTaskStatementDigest(statement),
  };
  const record = deliveryRecord({
    repository: PASSPORT,
    id: "issue-ubiquity-passport.ubq.fi-58",
    source: { kind: "issue", id: "58", revision: BASE },
    related: { incidentId: null, issueNumber: 58 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-passport.ubq.fi-58",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    },
  });
  const receipt = authorizingReceipt({
    repository: PASSPORT,
    pullRequest: { number: 51, head: HEAD, base: BASE },
    taskAcceptance: {
      issueNumber: 58,
      taskDigest: task.digest,
      verdict: "fulfilled",
      evidence: ["the reviewed candidate satisfies issue 58"],
    },
  });
  assert.equal(
    reviewAuthorizesMerge(receipt, record, "ubiquity-sentinel[bot]", task),
    true,
    "the clean review still authorizes the merge",
  );
});
