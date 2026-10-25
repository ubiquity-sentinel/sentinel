/**
 * Base-repair lane (2026-10-24 throughput redesign, stage 1; reworked
 * 2026-10-25 after its review). A red target base wedged every repair in it:
 * the CI-first gate holds a head whose failing checks are red on the base too
 * (`base_red`) for a base move only a merge can cause. The launcher files one
 * unlabelled base-repair issue per red tip that holds records
 * (`ops/hosted-autonomy-base-repair.ts`), and for that task alone (the App's
 * issue with the marker on its first line; no label, no severity) a
 * `base_red` failure on the current tip is its own: it takes the ordinary
 * charged CI fix route, for exactly the checks red on both, with a finding
 * that does not claim they passed on the base. Every other record keeps the
 * hold; an unavailable issue or tip read defers without a write; a base that
 * is no longer the tip refreshes first, uncharged.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type GitHubIssueV1,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop-types.ts";
import {
  BASE_REPAIR_AUTHOR,
  baseRepairMarker,
  isBaseRepairBody,
  isBaseRepairTask,
  ownBaseRed,
  parseBaseRepairMarker,
} from "../../src/repair/base-repair.ts";
import {
  attributeFailedChecks,
  CI_BASE_REPAIR_FINDING_PREFIX,
  CI_CORRECTION_FINDING_PREFIX,
  ciCorrectionFinding,
  HOSTED_BASE_REPAIR_FINDING,
  isCiCorrectionFinding,
} from "../../src/repair/ci-rejection.ts";
import { confirmCiCorrection } from "../../src/repair/loop-ci-correction.ts";
import { confirmPreReviewCiFix } from "../../src/repair/loop-ci-first.ts";
import { isCiFixMarker } from "../../src/repair/ci-first-policy.ts";
import { SHA1, SHA2, SHA3, workRecord } from "../state/helpers.ts";
import { check, ciFirstRig, taskRecord } from "./ci-first-rig.ts";
import { ciRig } from "./ci-correction-rig.ts";

const RED = {
  [SHA3]: [check("deno", SHA3, "failure")],
  [SHA1]: [check("deno", SHA1, "failure")],
};

function issue(overrides: Partial<GitHubIssueV1> = {}): GitHubIssueV1 {
  return {
    number: 1,
    title: "CI is failing on development",
    body: `${baseRepairMarker("development", SHA1)}\n\nCI is failing.`,
    state: "open",
    author: BASE_REPAIR_AUTHOR,
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    closedAt: null,
    ...overrides,
  };
}

type IssueRead = Awaited<ReturnType<RepairCycleDepsV1["github"]["readIssue"]>>;

async function gateOutcome(
  /** One answer for every read, or the answer to the nth read (from 0). */
  read: IssueRead | ((call: number) => IssueRead),
  options: { hosted?: boolean; checks?: typeof RED; prefix?: string } = {},
) {
  const { rig, charges, writes } = await ciFirstRig(
    `base-repair-${options.prefix ?? "gate"}`,
    { hosted: options.hosted ?? true, checks: options.checks ?? RED },
  );
  const reads: number[] = [];
  rig.github.readIssue = (number: number) => {
    reads.push(number);
    return Promise.resolve(
      typeof read === "function" ? read(reads.length - 1) : read,
    );
  };
  try {
    const outcome = await rig.run();
    const after = await rig.snapshot();
    return {
      outcome,
      work: taskRecord(after),
      reads,
      charges,
      after,
      rig,
      writes,
    };
  } finally {
    await rig.ctx.cleanup();
  }
}

Deno.test("base repair: the marker is the first body line only and binds the branch and tip", () => {
  const marker = baseRepairMarker("main", SHA1);
  assert.equal(marker, `<!-- sentinel:base-repair:main@${SHA1} -->`);
  assert.equal(isBaseRepairBody(marker), true);
  assert.equal(isBaseRepairBody(`${marker}\r\nbody`), true);
  assert.equal(isBaseRepairBody(`intro\n${marker}`), false);
  assert.deepEqual(parseBaseRepairMarker(marker), {
    branch: "main",
    tip: SHA1,
  });
  // The first, tip-less form still names its branch.
  assert.deepEqual(
    parseBaseRepairMarker("<!-- sentinel:base-repair:main -->"),
    { branch: "main", tip: null },
  );
  for (
    const line of [
      "",
      "CI is failing on main",
      "<!-- sentinel:base-repair: -->",
      `<!-- sentinel:base-repair:main@${SHA1} --> trailing`,
    ]
  ) assert.equal(parseBaseRepairMarker(line), null, line);
});

Deno.test("base repair: the base-repair task's red base is its own failure and takes the CI fix route, without a label or P0", async () => {
  const { work, reads } = await gateOutcome(portOk(issue()));
  assert.notEqual(
    work.classification.severity,
    "P0",
    "no severity precondition",
  );
  assert.deepEqual(reads, [1]);
  assert.equal(work.nextStep, "work");
  assert.equal(work.blocker, null);
  assert.ok(isCiFixMarker(work.wait), JSON.stringify(work.wait));
});

Deno.test("base repair: the fix lists only the checks red on both and never claims they passed on the base", async () => {
  const checks = {
    [SHA3]: [
      check("deno", SHA3, "failure"),
      check("lint", SHA3, "cancelled"),
    ],
    [SHA1]: [check("deno", SHA1, "failure"), check("lint", SHA1, "failure")],
  };
  // In process the gate marks the fix and admits it in the same run.
  const { rig } = await gateOutcome(portOk(issue()), {
    hosted: false,
    checks,
    prefix: "finding",
  });
  assert.equal(rig.model.requests.length, 1, "one charged CI fix");
  const finding = rig.model.requests[0].reviewFindings![0];
  assert.ok(isCiCorrectionFinding(finding), finding.message);
  assert.ok(finding.message.startsWith(CI_BASE_REPAIR_FINDING_PREFIX));
  assert.ok(!finding.message.includes("passed"), finding.message);
  assert.match(finding.message, /deno \(failure\)/);
  assert.ok(
    !finding.message.includes("lint"),
    "a secondary check is not its own",
  );
});

Deno.test("base repair: every other red-base record keeps the uncharged hold", async () => {
  for (
    const read of [
      portOk(issue({ author: "someone" })),
      portOk(issue({ body: "CI is failing on development" })),
      portOk(
        issue({ body: `quoted:\n${baseRepairMarker("development", SHA1)}` }),
      ),
      portOk(null),
    ]
  ) {
    const { work, reads, charges, after } = await gateOutcome(read);
    assert.deepEqual(reads, [1], "read only for its base_red disposition");
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.equal(work.wait?.reason, "backoff", JSON.stringify(work.wait));
    assert.equal(isCiFixMarker(work.wait), false);
    assert.deepEqual(after.reservations, charges, "nothing charged");
  }
});

Deno.test("base repair: a failure the base does not share reads no issue", async () => {
  const { reads } = await gateOutcome(portOk(issue()), {
    checks: {
      [SHA3]: [check("deno", SHA3, "failure")],
      [SHA1]: [check("deno", SHA1, "success")],
    },
    prefix: "candidate",
  });
  assert.deepEqual(reads, []);
});

Deno.test("base repair: an unavailable issue read defers the gate without a write", async () => {
  const held = await gateOutcome(portOk(null), { prefix: "held" });
  // Only the gate's read fails; any later read (a review request's task
  // statement) would answer the blanket fake's ordinary issue #1.
  const ordinary = issue({ title: "issue 1", body: "", author: null });
  const { work, outcome, writes, charges, after, rig, reads } =
    await gateOutcome(
      (call) =>
        call === 0
          ? portError("unavailable", "issue read failed")
          : portOk(ordinary),
      { prefix: "unavailable" },
    );
  assert.equal(outcome.status, "margin", JSON.stringify(outcome));
  assert.deepEqual(reads, [1], "nothing after the gate's read");
  // The publication's own write precedes the gate; the gate adds none (the
  // hold it would have written is the one more write of the held run).
  assert.equal(writes.length, held.writes.length - 1);
  assert.equal(work.wait, null, "the gate left the record untouched");
  assert.equal(work.blocker, null);
  assert.equal(work.nextStep, "work");
  assert.equal(rig.github.calls.includes("requestReview"), false);
  assert.deepEqual(after.reservations, charges, "no review is reserved");
});

/** A minimal deps over a readIssue/readRef pair (the base is SHA1). */
function directDeps(
  tip: IssueRead | null,
  ref: () => Promise<
    Awaited<ReturnType<RepairCycleDepsV1["github"]["readRef"]>>
  >,
) {
  const calls: string[] = [];
  const record = workRecord("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: { base: SHA1, branch: "b", checkpoint: null, head: SHA3, pr: 7 },
  });
  const deps = {
    clock: { now: () => 0 },
    github: {
      readIssue: () => {
        calls.push("issue");
        return Promise.resolve(tip ?? portOk(issue()));
      },
      readRef: (name: string) => {
        calls.push(`ref:${name}`);
        return ref();
      },
      readChecks: (head: GitSha) =>
        Promise.resolve(portOk({ head, checks: RED[head] ?? [] })),
    },
    configs: [{ repository: record.repository, baseBranch: "development" }],
  } as unknown as RepairCycleDepsV1;
  return { deps, record, calls };
}

Deno.test("base repair: a hosted fix keeps the opening its rollback target recognises", async () => {
  const at = () =>
    Promise.resolve(portOk({ ref: "refs/heads/development", sha: SHA1 }));
  assert.equal(HOSTED_BASE_REPAIR_FINDING, false);
  for (const hosted of [false, true]) {
    for (const confirm of [confirmPreReviewCiFix, confirmCiCorrection]) {
      const { deps, record } = directDeps(null, at);
      const run = hosted ? { ...deps, externalImplementations: true } : deps;
      const confirmed = await confirm(run, null as never, record);
      assert.equal(confirmed.kind, "confirmed", JSON.stringify(confirmed));
      const message = confirmed.kind === "confirmed"
        ? confirmed.finding.message
        : "";
      assert.ok(
        message.startsWith(
          hosted ? CI_CORRECTION_FINDING_PREFIX : CI_BASE_REPAIR_FINDING_PREFIX,
        ),
        `${confirm.name} hosted=${hosted}: ${message}`,
      );
    }
  }
});

const ATTRIBUTION = attributeFailedChecks(
  [check("deno", SHA3, "failure"), check("lint", SHA3, "cancelled")],
  [check("deno", SHA1, "failure"), check("lint", SHA1, "failure")],
);

Deno.test("base repair: ownBaseRed converts only on the current tip, with only the base-red checks", async () => {
  const at = (sha: GitSha) => () =>
    Promise.resolve(portOk({ ref: "refs/heads/development", sha }));
  const same = directDeps(null, at(SHA1));
  const owned = await ownBaseRed(same.deps, same.record, ATTRIBUTION);
  assert.equal(owned?.kind, "candidate");
  assert.deepEqual(
    owned?.kind === "candidate" ? owned.checks.map((c) => c.name) : [],
    ["deno"],
  );
  assert.equal(owned?.kind === "candidate" && owned.redBase, true);
  assert.deepEqual(same.calls, ["issue", "ref:refs/heads/development"]);
  // A moved base keeps `base_red`: the refresh comes first, uncharged.
  const moved = directDeps(null, at(SHA2));
  assert.deepEqual(await ownBaseRed(moved.deps, moved.record, ATTRIBUTION), {
    kind: "base_red",
  });
  // An unreadable tip or issue is unavailable (null).
  for (
    const [tip, ref] of [
      [null, () => Promise.resolve(portError("unavailable", "ref"))],
      [null, () => Promise.resolve(portOk(null))],
      [null, () => Promise.reject(new Error("transport"))],
      [portError("unavailable", "issue"), at(SHA1)],
    ] as const
  ) {
    const unread = directDeps(tip, ref);
    assert.equal(
      await ownBaseRed(unread.deps, unread.record, ATTRIBUTION),
      null,
    );
  }
  // Any other disposition is returned without a read.
  const green = directDeps(null, at(SHA1));
  const candidate = attributeFailedChecks(
    [check("deno", SHA3, "failure")],
    [check("deno", SHA1, "success")],
  );
  const kept = await ownBaseRed(green.deps, green.record, candidate);
  assert.equal(kept?.kind, "candidate");
  assert.equal(kept?.kind === "candidate" && kept.redBase, undefined);
  assert.deepEqual(green.calls, []);
});

Deno.test("base repair: isBaseRepairTask is three-way and memoised per run", async () => {
  const at = () =>
    Promise.resolve(portOk({ ref: "refs/heads/development", sha: SHA1 }));
  const run = directDeps(null, at);
  assert.equal(await isBaseRepairTask(run.deps, run.record), true);
  assert.equal(await isBaseRepairTask(run.deps, run.record), true);
  assert.deepEqual(run.calls, ["issue"], "one read per run");
  const unavailable = directDeps(portError("unavailable", "issue"), at);
  assert.equal(
    await isBaseRepairTask(unavailable.deps, unavailable.record),
    null,
  );
  assert.equal(
    await isBaseRepairTask(unavailable.deps, unavailable.record),
    null,
  );
  assert.deepEqual(unavailable.calls, ["issue", "issue"], "never memoised");
  const other = directDeps(portOk(issue({ author: "someone" })), at);
  assert.equal(await isBaseRepairTask(other.deps, other.record), false);
});

Deno.test("base repair: the finding keeps both openings recognised", () => {
  const checks = [check("deno", SHA3, "failure")];
  const ordinary = ciCorrectionFinding(SHA1, checks);
  const own = ciCorrectionFinding(SHA1, checks, true);
  assert.ok(ordinary.message.startsWith(CI_CORRECTION_FINDING_PREFIX));
  assert.ok(own.message.startsWith(CI_BASE_REPAIR_FINDING_PREFIX));
  assert.ok(isCiCorrectionFinding(ordinary) && isCiCorrectionFinding(own));
  assert.equal(
    isCiCorrectionFinding({ ...own, message: `x${own.message}` }),
    false,
  );
});

Deno.test("base repair: a reviewed base-repair head on the tip is corrected; on a moved base it refreshes first, uncharged", async () => {
  const task = issue({ title: "issue 1" });
  // The clean review accepted this issue's own text.
  const taskDigest = await reviewTaskStatementDigest({
    issueNumber: 1,
    title: task.title,
    body: task.body,
  });
  for (const [tip, corrected] of [[SHA1, true], [SHA2, false]] as const) {
    const { rig, refreshes, charges } = await ciRig(
      `base-repair-moved-${corrected}`,
      {
        hosted: true,
        baseTip: tip,
        taskDigest,
        checks: {
          [SHA3]: [check("validate", SHA3, "failure")],
          [SHA1]: [check("validate", SHA1, "failure")],
        },
      },
    );
    rig.github.readIssue = () => Promise.resolve(portOk(task));
    try {
      const outcome = await rig.run();
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const after = await rig.snapshot();
      const work = after.work[0];
      assert.deepEqual(after.reservations, charges, "nothing charged yet");
      assert.equal(
        refreshes.some((request) => request.expectedHead === SHA3),
        !corrected,
        "only a moved base is refreshed",
      );
      if (corrected) {
        assert.equal(work.nextStep, "work", JSON.stringify(work));
        assert.equal(work.target.head, SHA3);
      }
    } finally {
      await rig.ctx.cleanup();
    }
  }
});
