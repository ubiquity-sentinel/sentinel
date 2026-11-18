/**
 * A base-repair task's fresh implementation start carries the checks its red
 * base fails as the base-repair CI finding (live: ai.ubq.fi 1370's first start
 * had only the issue body and made no change), through the real repair loop
 * in process with fake GitHub and model ports. The finding is what a matrix
 * cell keys its existing CI evidence read on (`matrix-cell-ci-evidence_test`).
 * An ordinary start's request and prompt are byte-identical to before (their
 * digests are pinned from the runtime before this change); an unread base
 * check or issue defers the start, uncharged.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import {
  type GitHubCheckV1,
  type GitHubIssueV1,
  type ModelRunRequestV1,
  portError,
} from "../../src/contracts/ports.ts";
import {
  BASE_REPAIR_START_UNAVAILABLE,
  baseRepairStartFinding,
} from "../../src/repair/base-repair-start.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { CANDIDATE_COMMIT_REFUSAL_DETAILS } from "../../src/repair/model-port-checkout.ts";
import { buildPrompt } from "../../src/repair/model-port-prompt.ts";
import { SHA2, workRecord } from "../state/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";

const ID = asWorkItemId("issue-ubiquity-ai.ubq.fi-1370");
const MARKER = `<!-- sentinel:base-repair:development@${SHA2} -->`;
/** The base-repair CI fix opening, as the hosted rollback target reads it. */
const RED_BASE =
  "Required CI checks failed on this candidate and on its red base ";
/** Request and prompt of an ordinary fresh start before this change. */
const ORDINARY_REQUEST =
  "ca740924a85121727144c86947e905182e11b05e870fdfed7ae67cb2b1f22f74";
const ORDINARY_PROMPT =
  "23f87a9321b9d7dcdf3c1c262d851f47bc031f8be0b00c77bbf16d69c7704221";

function check(
  name: string,
  conclusion: GitHubCheckV1["conclusion"],
): GitHubCheckV1 {
  return {
    name,
    status: "completed",
    conclusion,
    head: SHA2,
    startedAt: 1,
    completedAt: 2,
  };
}

const CHECKS = [
  check("deno", "failure"),
  check("lint", "success"),
  check("e2e", "cancelled"),
];

type Issue = "app" | "person" | "ordinary";

function issue(kind: Issue): GitHubIssueV1 {
  return issueRecord(1370, {
    title: kind === "ordinary"
      ? "Fix the build"
      : "CI is failing on development",
    body: kind === "ordinary"
      ? "The build fails on every pull request."
      : `${MARKER}\n\nCI is failing on \`development\` at ${SHA2}.`,
    // A person's issue is the admitted owner's (2026-11-17): the marker in
    // it still makes no base repair.
    ...(kind === "app"
      ? { author: "ubiquity-sentinel[bot]" }
      : { author: "0x4007", authorId: 4975670 }),
    relations: { openBlockers: [], subIssueCount: 0 },
  });
}

/** One cycle over issue 1370's fresh record; the model changes nothing. */
async function start(
  kind: Issue,
  checksReadable = true,
  checks: GitHubCheckV1[] = CHECKS,
) {
  const github = new RelationsFakeGithub({ baseSha: SHA2, checks });
  github.latest.set(1370, issue(kind));
  if (!checksReadable) {
    github.readChecks = () =>
      Promise.resolve(portError("unavailable", "checks unavailable"));
  }
  const rig = makeMemoryRig(github);
  rig.model.runModel = (request: ModelRunRequestV1) => {
    rig.model.requests.push(request);
    return Promise.resolve(
      portError("unavailable", CANDIDATE_COMMIT_REFUSAL_DETAILS.unchanged_base),
    );
  };
  // Its branch identity is already assigned, as on the live record.
  const record = workRecord(ID, {
    source: { kind: "issue", id: "1370", revision: SHA2 },
    related: { issueNumber: 1370, incidentId: null },
    target: {
      base: SHA2,
      head: null,
      pr: null,
      branch: candidateBranch(ID),
      checkpoint: null,
    },
    counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    nextStep: "work",
    intent: null,
  });
  await rig.state.writeRepair(seededSnapshot([record]), null);
  const before = await rig.snapshot();
  await rig.run();
  return { rig, before, after: await rig.snapshot() };
}

Deno.test("base-repair start: a fresh start carries its red base's failing checks as the base-repair finding", async () => {
  const { rig, after } = await start("app");
  assert.equal(rig.model.requests.length, 1);
  const request = rig.model.requests[0];
  assert.equal(request.checkoutBase, undefined, "the checkout is the base");
  assert.deepEqual(request.reviewFindings, [{
    severity: "P1",
    path: null,
    message: `${RED_BASE}${SHA2.slice(0, 12)}: deno (failure). ` +
      "Reproduce them with the repository's own test and check commands " +
      "and fix the candidate so they pass.",
  }]);
  // An implementation start, never a charged CI fix (`counters.retries`).
  assert.deepEqual(after.reservations.map((row) => row.purpose), [
    "implementation",
  ]);
  assert.equal(after.work[0].counters.attempts, 1);
  assert.equal(after.work[0].counters.retries, 0);
});

Deno.test("base-repair start: an ordinary start's request and prompt are byte-identical", async () => {
  const { rig } = await start("ordinary");
  assert.equal(rig.model.requests.length, 1);
  const request = rig.model.requests[0];
  assert.equal(request.reviewFindings, undefined);
  assert.equal(await canonicalStringifySha256(request), ORDINARY_REQUEST);
  const prompt = new TextEncoder().encode(buildPrompt(request, false));
  const digest = await crypto.subtle.digest("SHA-256", prompt);
  assert.equal(
    [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    ORDINARY_PROMPT,
  );
  // The marker alone, on a person's issue, carries no finding either.
  const person = await start("person");
  assert.equal(person.rig.model.requests.length, 1);
  assert.equal(person.rig.model.requests[0].reviewFindings, undefined);
});

Deno.test("base-repair start: an unread base check defers the start without a write or charge", async () => {
  const { rig, before, after } = await start("app", false);
  assert.equal(rig.model.requests.length, 0);
  assert.deepEqual(after.reservations, []);
  assert.deepEqual(after.work, before.work);
});

Deno.test("base-repair start: a base with checks still running or none reported defers the start, uncharged", async () => {
  const running = {
    ...check("deno", null),
    status: "in_progress",
    completedAt: null,
  } as GitHubCheckV1;
  for (const checks of [[running, check("lint", "success")], []]) {
    const { rig, before, after } = await start("app", true, checks);
    assert.equal(rig.model.requests.length, 0);
    assert.deepEqual(after.reservations, []);
    assert.deepEqual(after.work, before.work);
  }
  // A completed red check starts it even while another is still running.
  const { rig } = await start("app", true, [running, check("e2e", "failure")]);
  assert.equal(rig.model.requests.length, 1);
  assert.match(
    rig.model.requests[0].reviewFindings?.[0].message ?? "",
    /: e2e \(failure\)\. /,
  );
});

Deno.test("base-repair start: an unread issue author defers; a base with no failed check carries nothing", async () => {
  const record = workRecord(ID, {
    source: { kind: "issue", id: "1370", revision: SHA2 },
    related: { issueNumber: 1370, incidentId: null },
  });
  const body = { body: issue("app").body };
  const unread = new RelationsFakeGithub({ baseSha: SHA2, checks: CHECKS });
  unread.readIssue = () =>
    Promise.resolve(portError("unavailable", "issue unavailable"));
  assert.deepEqual(
    await baseRepairStartFinding({ github: unread }, record, body),
    { kind: "unavailable", detail: BASE_REPAIR_START_UNAVAILABLE },
  );
  const green = new RelationsFakeGithub({
    baseSha: SHA2,
    checks: [check("deno", "success")],
  });
  green.latest.set(1370, issue("app"));
  assert.deepEqual(
    await baseRepairStartFinding({ github: green }, record, body),
    { kind: "none" },
  );
  // Without the marker nothing is read at all.
  const silent = new RelationsFakeGithub({ baseSha: SHA2 });
  silent.readIssue = () => Promise.reject(new Error("must not be read"));
  silent.readChecks = () => Promise.reject(new Error("must not be read"));
  assert.deepEqual(
    await baseRepairStartFinding({ github: silent }, record, {
      body: "The build fails on every pull request.",
    }),
    { kind: "none" },
  );
});
