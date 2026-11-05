/**
 * The launcher's foreign green read (`hasAllChecksGreen`) never counts a
 * review bot's check as CI evidence (live ai.ubq.fi #1348, #1353, #1354: one
 * skipped `CodeRabbit` check and no `Gateway CI` run on the merged heads). A
 * head with only that check is unreadable (null): neither green nor red.
 *
 * The read is the real `createHostedAutonomyGitHub` surface over a scripted
 * transport; no network, credential, model or external write is used.
 */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy.ts";
import {
  checkRun,
  checkRunPage,
  HEAD,
  jsonResponse,
} from "./hosted-autonomy-fixtures.ts";

const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;

async function withHeadRuns<T>(
  runs: readonly unknown[],
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      jsonResponse(checkRunPage([...runs], runs.length)),
    )) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const SKIPPED_BOT = checkRun("CodeRabbit", {
  conclusion: "skipped",
  check_suite: { id: 21 },
});

Deno.test("launcher green read: a lone skipped CodeRabbit check is no CI evidence", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  assert.equal(
    await withHeadRuns([SKIPPED_BOT], () => surface.hasAllChecksGreen(HEAD)),
    null,
  );
});

Deno.test("launcher green read: next to a green Gateway CI job the bot check changes nothing", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  const validate = checkRun("validate", { check_suite: { id: 22 } });
  assert.equal(
    await withHeadRuns(
      [SKIPPED_BOT, validate],
      () => surface.hasAllChecksGreen(HEAD),
    ),
    true,
  );
});

const GITGUARDIAN = checkRun("GitGuardian Security Checks", {
  app: { slug: "gitguardian" },
  check_suite: { id: 23 },
});

Deno.test("launcher green read: a lone green foreign-app check is no CI evidence", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  assert.equal(
    await withHeadRuns([GITGUARDIAN], () => surface.hasAllChecksGreen(HEAD)),
    null,
  );
});

Deno.test("launcher green read: a failed foreign-app check is red", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  const socket = checkRun("Socket Security", {
    app: { slug: "socket-security" },
    conclusion: "failure",
    check_suite: { id: 24 },
  });
  assert.equal(
    await withHeadRuns(
      [GITGUARDIAN, socket],
      () => surface.hasAllChecksGreen(HEAD),
    ),
    false,
  );
});

Deno.test("launcher green read: a GitHub Actions success next to a foreign app is green", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  const validate = checkRun("validate", {
    app: { slug: "github-actions" },
    check_suite: { id: 25 },
  });
  assert.equal(
    await withHeadRuns(
      [GITGUARDIAN, validate],
      () => surface.hasAllChecksGreen(HEAD),
    ),
    true,
  );
});

Deno.test("launcher green read: a legacy check with no app is CI evidence", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  const ci = checkRun("ci", { check_suite: { id: 26 } });
  assert.equal(
    await withHeadRuns(
      [GITGUARDIAN, ci],
      () => surface.hasAllChecksGreen(HEAD),
    ),
    true,
  );
});

Deno.test("launcher green read: a lone skipped check from the coderabbit app is no CI evidence", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  const bot = checkRun("Review", {
    app: { slug: "coderabbit" },
    conclusion: "skipped",
    check_suite: { id: 28 },
  });
  assert.equal(
    await withHeadRuns([bot], () => surface.hasAllChecksGreen(HEAD)),
    null,
  );
});

Deno.test("launcher green read: a lone job the target's own Actions CI skipped is green", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  const validate = checkRun("validate", {
    app: { slug: "github-actions" },
    conclusion: "skipped",
    check_suite: { id: 29 },
  });
  assert.equal(
    await withHeadRuns([validate], () => surface.hasAllChecksGreen(HEAD)),
    true,
  );
});

Deno.test("launcher green read: an app with no readable slug never passes for Actions", async () => {
  const surface = createHostedAutonomyGitHub("fixture-token", AI);
  const odd = checkRun("validate", { app: {}, check_suite: { id: 27 } });
  assert.equal(
    await withHeadRuns([odd], () => surface.hasAllChecksGreen(HEAD)),
    null,
  );
});
