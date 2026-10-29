/**
 * CI attribution with backup CI evidence (docs/backup-ci-spec.md §11.3,
 * `attributeFailedChecks`): like is compared with like. A backup stand-in red
 * on the head is attributed only against the base's own stand-in or its
 * backup peer; a native head red against a backup base only through the
 * head's backup peer; a never-started base without backup is never `baseRed`;
 * and native against native is unchanged (a peer there is inert). Every row
 * of the §11.3 table, all synthetic.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import {
  attributeFailedChecks,
  type CiAttributionV1,
  decideCiDisposition,
  failedChecks,
} from "../../src/repair/ci-rejection.ts";

const HEAD = "a".repeat(40) as GitSha;
const BASE = "b".repeat(40) as GitSha;
const T0 = Date.parse("2026-10-25T08:00:00Z");
const BACKUP = {
  receipt:
    "bci1:ubiquity/passport.ubq.fi@aaaaaaaaaaaa:.github/workflows/ci.yml#deno:push:a1",
  context: "push" as const,
  runnerId: "0123456789abcdef",
  legRunId: 5001,
  legJobId: 6001,
};

function check(
  conclusion: GitHubCheckV1["conclusion"],
  over: Partial<GitHubCheckV1> = {},
  head: GitSha = HEAD,
): GitHubCheckV1 {
  return {
    name: "deno",
    status: "completed",
    conclusion,
    head,
    startedAt: T0,
    completedAt: T0 + 1_000,
    ...over,
  };
}

const backupHead = (conclusion: "failure" | "timed_out" = "failure") =>
  check(conclusion, { backup: BACKUP });
const backupBase = (conclusion: "success" | "failure" | "timed_out") =>
  check(conclusion, { backup: BACKUP }, BASE);
const nativeBase = (
  conclusion: GitHubCheckV1["conclusion"],
  over: Partial<GitHubCheckV1> = {},
) => check(conclusion, over, BASE);
const peer = (conclusion: "success" | "failure" | "timed_out") => ({
  backupPeer: { conclusion, receipt: BACKUP.receipt },
});

/** The attribution bucket of the single head failure against `base`. */
function bucket(
  head: GitHubCheckV1,
  base: GitHubCheckV1 | null,
): keyof CiAttributionV1 {
  const attribution = attributeFailedChecks(
    [head],
    base === null ? [] : [base],
  );
  const found = (Object.keys(attribution) as (keyof CiAttributionV1)[])
    .filter((k) => attribution[k].length > 0);
  assert.equal(found.length, 1);
  assert.equal(attribution[found[0]][0], head);
  return found[0];
}

Deno.test("a backup head red against base backup evidence", () => {
  // The base's own stand-in, or the base's backup peer, is the comparison.
  assert.equal(bucket(backupHead(), backupBase("success")), "candidate");
  assert.equal(
    bucket(backupHead("timed_out"), nativeBase("failure", peer("success"))),
    "candidate",
  );
  assert.equal(bucket(backupHead(), backupBase("failure")), "baseRed");
  assert.equal(bucket(backupHead(), backupBase("timed_out")), "baseRed");
  assert.equal(
    bucket(backupHead(), nativeBase("success", peer("failure"))),
    "baseRed",
  );
  assert.equal(
    bucket(backupHead(), nativeBase("success", peer("timed_out"))),
    "baseRed",
  );
});

Deno.test("a backup head red without base backup evidence is unattributed", () => {
  // The base's native verdict is never compared with a backup head.
  for (
    const base of [
      null,
      nativeBase("success"),
      nativeBase("failure"),
      nativeBase("action_required"),
      nativeBase(null, { status: "in_progress", completedAt: null }),
      nativeBase("failure", { neverStarted: true }),
      nativeBase("skipped"),
    ]
  ) {
    assert.equal(
      bucket(backupHead(), base),
      "unattributed",
      String(base?.conclusion),
    );
  }
});

Deno.test("a native head red against a backup base needs the head's peer", () => {
  assert.equal(
    bucket(check("failure", peer("failure")), backupBase("success")),
    "candidate",
  );
  assert.equal(
    bucket(check("timed_out", peer("timed_out")), backupBase("success")),
    "candidate",
  );
  assert.equal(
    bucket(check("failure", peer("failure")), backupBase("failure")),
    "baseRed",
  );
  assert.equal(
    bucket(check("failure", peer("timed_out")), backupBase("timed_out")),
    "baseRed",
  );
  // No peer, or a green peer: the planner schedules a head peer.
  assert.equal(bucket(check("failure"), backupBase("success")), "unattributed");
  assert.equal(bucket(check("failure"), backupBase("failure")), "unattributed");
  assert.equal(
    bucket(check("failure", peer("success")), backupBase("success")),
    "unattributed",
  );
  assert.equal(
    bucket(check("failure", peer("success")), backupBase("failure")),
    "unattributed",
  );
});

Deno.test("a never-started base without backup is unattributed, never baseRed", () => {
  for (const conclusion of ["failure", "timed_out"] as const) {
    assert.equal(
      bucket(check("failure"), nativeBase(conclusion, { neverStarted: true })),
      "unattributed",
    );
    assert.equal(
      bucket(
        check("failure", peer("failure")),
        nativeBase(conclusion, { neverStarted: true }),
      ),
      "unattributed",
    );
  }
});

Deno.test("native against native is unchanged, and a peer there is inert", () => {
  const rows: [GitHubCheckV1 | null, keyof CiAttributionV1][] = [
    [nativeBase("success"), "candidate"],
    [nativeBase("failure"), "baseRed"],
    [nativeBase("timed_out"), "baseRed"],
    [nativeBase("action_required"), "baseRed"],
    [
      nativeBase(null, { status: "in_progress", completedAt: null }),
      "basePending",
    ],
    [nativeBase("skipped"), "unattributed"],
    [nativeBase("cancelled"), "unattributed"],
    [null, "unattributed"],
  ];
  for (const [base, expected] of rows) {
    assert.equal(bucket(check("failure"), base), expected);
    assert.equal(bucket(check("failure", peer("failure")), base), expected);
    assert.equal(bucket(check("failure", peer("success")), base), expected);
  }
  // A base peer is inert for a native head.
  assert.equal(
    bucket(check("failure"), nativeBase("success", peer("failure"))),
    "candidate",
  );
  // Non-candidate head conclusions stay secondary, backup or not.
  assert.equal(
    bucket(check("cancelled", { backup: BACKUP }), backupBase("success")),
    "secondary",
  );
});

Deno.test("a red stand-in is a failed check and decides the disposition", () => {
  const neverStarted = check("failure", { neverStarted: true });
  assert.deepEqual(failedChecks([neverStarted]), []);
  const red = backupHead();
  assert.deepEqual(failedChecks([red]), [red]);
  assert.deepEqual(
    decideCiDisposition(attributeFailedChecks([red], [backupBase("success")])),
    { kind: "candidate", checks: [red] },
  );
  assert.deepEqual(
    decideCiDisposition(attributeFailedChecks([red], [backupBase("failure")])),
    { kind: "base_red" },
  );
  assert.deepEqual(
    decideCiDisposition(attributeFailedChecks([red], [nativeBase("success")])),
    { kind: "unattributed", checks: [red] },
  );
});
