/** Exact base-only review without invented commits, paths, or PR identities. */
import assert from "node:assert/strict";
import { asGitSha } from "../../src/contracts/brands.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import {
  renderReviewPrompt,
  validateReviewSnapshotV1,
  verifyReviewSnapshotDigest,
} from "../../src/github/review-snapshot.ts";
import {
  agentMessage,
  BASE,
  CLEAN_RESULT,
  FINDINGS_RESULT,
  makeReviewer,
  prepareRequest,
  ScriptedCodexSession,
  snapshotFixture,
  submittedGuidance,
  submittedPrompt,
  turnCompleted,
} from "./codex-reviewer-helpers.ts";
import {
  commitAll,
  git,
  producer,
  publicationInput,
  withRepo,
} from "./review-snapshot-helpers.ts";

async function taskStatement() {
  const source = {
    issueNumber: 300,
    title: "Reject negative deposits",
    body: "The deposit function must reject negative amounts.",
  };
  return { ...source, digest: await reviewTaskStatementDigest(source) };
}

Deno.test("base task: exact commit capture has an empty native manifest and is never publishable", async () => {
  await withRepo(async (repo) => {
    await Deno.writeTextFile(
      `${repo}/account.ts`,
      "export const fixed = true;\n",
    );
    const base = await commitAll(repo, "already fixed");
    const port = producer(repo);
    const captured = await port.capture({ base, head: base });
    if (!captured.ok) assert.fail(captured.error.detail);
    assert.deepEqual(captured.value.files, []);
    assert.equal(captured.value.base, base);
    assert.equal(captured.value.head, base);
    assert.equal(captured.value.mergeBase, base);
    assert.equal(validateReviewSnapshotV1(captured.value), null);
    assert.equal(await verifyReviewSnapshotDigest(captured.value), true);
    const publish = await port.validatePublication(
      publicationInput(base, base),
    );
    assert.equal(publish.ok, false);
    assert.equal((await git(repo, ["status", "--porcelain"])).trim(), "");
    assert.equal(
      (await git(repo, ["rev-list", "--count", "HEAD"])).trim(),
      "1",
    );

    // Two distinct commits with no changed paths remain an invalid candidate.
    await git(repo, ["commit", "--allow-empty", "-m", "empty candidate"]);
    const head = asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
    const emptyCandidate = await port.capture({ base, head });
    assert.equal(emptyCandidate.ok, false);
  });
});

Deno.test("base task: empty manifests require exactly equal base, head, and merge base", async () => {
  const snapshot = await snapshotFixture({ head: BASE, files: [] });
  assert.equal(validateReviewSnapshotV1(snapshot), null);
  const inventedChange = await snapshotFixture({ head: BASE });
  assert.notEqual(validateReviewSnapshotV1(inventedChange), null);
  const other = asGitSha("c".repeat(40));
  for (
    const wrong of [
      { ...snapshot, head: other },
      { ...snapshot, mergeBase: other },
      { ...snapshot, base: other },
    ]
  ) assert.notEqual(validateReviewSnapshotV1(wrong), null);
});

Deno.test("base task: an empty review cannot start without a valid bound task", async () => {
  const snapshot = await snapshotFixture({ head: BASE, files: [] });
  const task = await taskStatement();
  for (
    const supplied of [undefined, null, { ...task, digest: "d".repeat(64) }]
  ) {
    const session = new ScriptedCodexSession();
    const result = await makeReviewer(session, { sessionCwd: Deno.cwd() })
      .prepare(prepareRequest(snapshot, { task: supplied }));
    assert.equal(result.ok, false);
    assert.equal(session.opened, 0);
    assert.equal(session.turnStarts(), 0);
  }
});

Deno.test("base task: native reviewer assesses exact-base acceptance without a change or merge claim", async () => {
  const task = await taskStatement();
  const snapshot = await snapshotFixture({ head: BASE, files: [] });
  const session = new ScriptedCodexSession();
  const acceptance = {
    issueNumber: task.issueNumber,
    taskDigest: task.digest,
    verdict: "already_satisfied_at_base",
    evidence: ["account.ts at the exact base rejects negative deposits."],
  };
  session.live = (scripted) => {
    scripted.emit("item/started", agentMessage(scripted.turnId, "result", ""));
    scripted.emit(
      "item/completed",
      agentMessage(
        scripted.turnId,
        "result",
        JSON.stringify({ ...CLEAN_RESULT, taskAcceptance: acceptance }),
      ),
    );
    scripted.emit("turn/completed", turnCompleted(scripted.turnId));
  };
  const prepared = await makeReviewer(session, { sessionCwd: Deno.cwd() })
    .prepare(prepareRequest(snapshot, { task }));
  if (!prepared.ok) assert.fail(prepared.error.detail);
  const outcome = await prepared.value.start();
  if (!outcome.ok) assert.fail(outcome.error.detail);
  assert.equal(outcome.value.status, "clean");
  assert.deepEqual(outcome.value.result?.taskAcceptance, acceptance);
  assert.ok(outcome.value.actual !== null);
  assert.ok(outcome.value.execution !== null);
  const prompt = submittedPrompt(session);
  assert.match(prompt, /BASE TASK ASSESSMENT/);
  assert.match(prompt, /No change is proposed/);
  assert.match(prompt, /already_satisfied_at_base/);
  assert.match(
    prompt,
    /Never claim a repair was delivered or authorize a merge/,
  );
  assert.match(submittedGuidance(session), /BASE TASK ASSESSMENT/);
  assert.ok(prompt.startsWith(renderReviewPrompt(snapshot, task)));
  const closed = await prepared.value.close();
  assert.equal(closed.settled, true);
});

Deno.test("base task: an invented changed-path finding cannot produce a ready result", async () => {
  const task = await taskStatement();
  const snapshot = await snapshotFixture({ head: BASE, files: [] });
  const session = new ScriptedCodexSession();
  session.live = (scripted) => {
    scripted.emit("item/started", agentMessage(scripted.turnId, "result", ""));
    scripted.emit(
      "item/completed",
      agentMessage(
        scripted.turnId,
        "result",
        JSON.stringify({
          ...FINDINGS_RESULT,
          taskAcceptance: {
            issueNumber: task.issueNumber,
            taskDigest: task.digest,
            verdict: "not_fulfilled",
            evidence: [
              "The base does not implement negative deposit rejection.",
            ],
          },
        }),
      ),
    );
    scripted.emit("turn/completed", turnCompleted(scripted.turnId));
  };
  const prepared = await makeReviewer(session, { sessionCwd: Deno.cwd() })
    .prepare(prepareRequest(snapshot, { task }));
  if (!prepared.ok) assert.fail(prepared.error.detail);
  const outcome = await prepared.value.start();
  if (!outcome.ok) assert.fail(outcome.error.detail);
  assert.equal(outcome.value.status, "unavailable");
  assert.equal(outcome.value.execution, null);
  assert.match(outcome.value.detail ?? "", /changed candidate file/);
  await prepared.value.close();
});
