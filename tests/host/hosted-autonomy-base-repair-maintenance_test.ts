/**
 * Base-repair filing through the real maintenance pass (`runHostedAutonomy`),
 * owner decision 2026-11-15: enabled for `ubiquity/ai.ubq.fi` only.
 * ai.ubq.fi, uusd.ubq.fi and permit2-rpc-manager each hold records on a red
 * tip, the live shape of that day. ai.ubq.fi gets exactly one issue, once,
 * whose text is the fixed template over its branch, its tip and the trusted
 * names of the checks red on both; the other two targets are never read. A
 * green tip files nothing, an open base-repair issue holds every new one,
 * and a create that fails or throws is tried at most once per pass without
 * stopping the phases after it.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  AI,
  appIssue,
  DAY,
  H1,
  H2,
  held,
  LIVE,
  maintain,
  MARKER,
  marker,
  OLD_TIP,
  PERMIT2,
  redTargets,
  TAG,
  TIPS,
  UUSD,
} from "./hosted-autonomy-base-repair-fixtures.ts";

Deno.test("base repair maintenance: ai.ubq.fi held on a red tip gets exactly one issue, once; uusd.ubq.fi and permit2-rpc-manager get nothing", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  const first = await maintain(LIVE(), targets);
  assert.deepEqual(first.baseRepair, [`${TAG}:filed=#9000`]);
  assert.equal(first.writes, 0, "filing writes no repair state");
  assert.equal(ai.created.length, 1);
  assert.equal(ai.created[0].title, "CI is failing on development");
  assert.equal(ai.created[0].body.split("\n")[0], MARKER);
  // The next pass, and a pass with a second ai.ubq.fi record held on the
  // same tip, file nothing more.
  const second = await maintain(LIVE(), targets);
  assert.deepEqual(second.baseRepair, [`${TAG}:filed_before=#9000`]);
  const third = await maintain([...LIVE(), held(AI, 1210, H2)], targets);
  assert.deepEqual(third.baseRepair, [`${TAG}:filed_before=#9000`]);
  assert.equal(ai.created.length, 1);
  assert.equal(ai.issues.length, 1);
  // The same state on the two targets outside the decision: never read.
  for (const name of [UUSD, PERMIT2]) {
    assert.deepEqual(targets[name].reads, [], name);
    assert.deepEqual(targets[name].created, [], name);
  }
});

Deno.test("base repair maintenance: a green ai.ubq.fi tip is read and files nothing", async () => {
  const targets = redTargets({
    failed: { [TIPS[AI]]: [], [H1]: ["validate"] },
  });
  const { baseRepair } = await maintain(LIVE(), targets);
  assert.deepEqual(baseRepair, []);
  assert.deepEqual(targets[AI].reads, [`checks:${TIPS[AI]}`], "no head read");
  assert.equal(targets[AI].created.length, 0);
});

Deno.test("base repair maintenance: an open base-repair issue holds every new one, whatever its records", async () => {
  const older = marker(OLD_TIP);
  const cases: [string, ReturnType<typeof appIssue>, WorkRecordV1[]][] = [
    // Its repair is parked (the fix failed) or done (merged, issue left open).
    ["parked", appIssue(77, older), [blockedOn(77)]],
    ["done", appIssue(77, older), [doneOn(77)]],
    // The first, tip-less marker, and another branch, are base repairs too.
    ["legacy", appIssue(77, "<!-- sentinel:base-repair:development -->"), []],
    ["branch", appIssue(77, older.replace("development", "main")), []],
  ];
  for (const [label, issue, records] of cases) {
    const targets = redTargets({
      failed: { [TIPS[AI]]: ["validate"], [H1]: ["validate"] },
      issues: [issue],
    });
    const { baseRepair } = await maintain([...LIVE(), ...records], targets);
    assert.deepEqual(baseRepair, [`${TAG}:open=#77`], label);
    assert.equal(targets[AI].created.length, 0, label);
  }
  // A closed one for an older tip, filed before the hard bound's 14-day
  // window, does not hold the new tip's issue.
  const targets = redTargets({
    failed: { [TIPS[AI]]: ["validate"], [H1]: ["validate"] },
    issues: [
      appIssue(77, older, { state: "closed", createdAt: T0 - 30 * DAY }),
    ],
  });
  const { baseRepair } = await maintain(LIVE(), targets);
  assert.deepEqual(baseRepair, [`${TAG}:filed=#9000`]);
});

Deno.test("base repair maintenance: a failed or throwing create is tried once per pass and never stops the phases after it", async () => {
  const red = { [TIPS[AI]]: ["validate"], [H1]: ["validate"] };
  // A transport failure: one create, then the next phases still run.
  const thrown = redTargets({ failed: red, create: "throws" });
  const failed = await maintain(LIVE(), thrown);
  assert.deepEqual(failed.baseRepair, [`${TAG}:unexpected_error`]);
  assert.equal(thrown[AI].created.length, 1);
  assert.notEqual(failed.result.status, "failed");
  const after = failed.progress.slice(
    failed.progress.indexOf("base_repair:start"),
  );
  for (
    const step of [
      "base_repair:finish",
      "ci_resume:start",
      "ci_resume:finish",
      "target_capability:start",
      "retired_pulls:start",
    ]
  ) assert.ok(after.includes(step), step);
  // GitHub kept the issue but the answer proved nothing: the next pass sees
  // its marker and files nothing more.
  const lost = redTargets({ failed: red, create: "lost" });
  const unproven = await maintain(LIVE(), lost);
  assert.deepEqual(unproven.baseRepair, [`${TAG}:file_failed`]);
  const next = await maintain(LIVE(), lost);
  assert.deepEqual(next.baseRepair, [`${TAG}:filed_before=#9000`]);
  assert.equal(lost[AI].created.length, 1);
  // GitHub refused it: one more create on the next pass, never two in one.
  const refused = redTargets({ failed: red, create: "refused" });
  for (const count of [1, 2]) {
    const pass = await maintain(LIVE(), refused);
    assert.deepEqual(pass.baseRepair, [`${TAG}:file_failed`]);
    assert.equal(refused[AI].created.length, count);
  }
});

Deno.test("base repair maintenance: the issue text is the fixed template over the branch, the tip and trusted check names", async () => {
  const shared = [
    "validate",
    "lint`<!-- sentinel:skip -->",
    "x\n@codex review",
    "<b>closes #5</b>",
  ];
  const targets = redTargets({
    failed: {
      [TIPS[AI]]: [...shared, "deploy-standby"],
      [H1]: [...shared, "head-only"],
    },
  });
  await maintain(LIVE(), targets);
  assert.equal(targets[AI].created.length, 1);
  const [issue] = targets[AI].created;
  assert.equal(issue.title, "CI is failing on development");
  assert.equal(
    issue.body,
    [
      MARKER,
      "",
      `CI is failing on \`development\` at ${
        TIPS[AI]
      }. Sentinel's open repairs in this repository fail the same checks, so none of them can merge until these checks pass on \`development\` again.`,
      "",
      "Failing checks:",
      "- `check with an unsupported name`",
      "- `validate`",
      "",
      "Fix the code so these checks pass on `development`. Change only what the failure requires.",
      "",
      "Filed automatically by Sentinel from the check results of that exact commit.",
    ].join("\n"),
  );
  // A default branch outside the plain ref shape files nothing at all.
  const odd = redTargets({
    failed: { [TIPS[AI]]: ["validate"], [H1]: ["validate"] },
    branch: "dev`<!--",
  });
  const { baseRepair } = await maintain(LIVE(), odd);
  assert.deepEqual(baseRepair, [`${TAG}:branch_unsupported`]);
  assert.deepEqual(odd[AI].reads, []);
  assert.equal(odd[AI].created.length, 0);
});

/** The repair of App issue `issue`, parked. */
function blockedOn(issue: number): WorkRecordV1 {
  return workRecord(`issue-ubiquity-ai.ubq.fi-${issue}`, {
    repository: { owner: "ubiquity", name: AI, installationId: 7 },
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    nextStep: "blocked",
    blocker: { kind: "other", message: "CI fix parked", since: T0 },
  });
}

/** The repair of App issue `issue`, delivered. */
function doneOn(issue: number): WorkRecordV1 {
  return workRecord(`issue-ubiquity-ai.ubq.fi-${issue}`, {
    repository: { owner: "ubiquity", name: AI, installationId: 7 },
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    nextStep: "done",
  });
}
