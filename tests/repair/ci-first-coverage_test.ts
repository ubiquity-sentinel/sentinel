/**
 * The CI-first review gate requires every expected check (sentinel issue
 * #154). `decideCiGate` judges only the check runs that exist, and GitHub
 * creates a `needs:` job's check run only once its dependencies finish, so a
 * head whose three early jobs are green read green before the required fourth
 * job existed and its review was requested. The gate now also reads the base
 * the head is tested against (the record's base, the reviewed base) and waits,
 * uncharged and bounded like running CI, until the head reports every check
 * name of each base check suite it shares a name with; the park names the
 * absent check under the existing pending prefix, which the launcher's re-run
 * and green rules re-admit. A base whose runs cannot be read is awaited the
 * same way (never a silent deferral); the base is read leniently (name and
 * suite, no label bound: live sentinel `development` carries 78-character
 * `matrix_cell` runs), and the sentinel self scope reads none, like the
 * launcher. Every write parses under the rollback target R80 (e48e7e110),
 * whose own launcher reads the park as its pending park; those cases are
 * skipped in a checkout without R80.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { preReviewCiParked } from "../../ops/hosted-autonomy-ci-first.ts";
import { REPO, SHA1, SHA3, T0 } from "../state/helpers.ts";
import { assertGen80Parses, gen80Available } from "../state/gen77-contracts.ts";
import { loadGen80Modules } from "../host/gen77-runtime-source.ts";
import {
  ciFirstRig,
  HOUR,
  reviewCharges,
  TASK,
  taskRecord,
} from "./ci-first-rig.ts";
import {
  LIVE_L80,
  LIVE_TIP,
  routeLiveDevelopment,
  suiteCheck,
} from "./ci-coverage-fixtures.ts";

const GEN80 = await gen80Available();

/** Gateway CI's four jobs; `verify-artifact` needs the other three. */
const JOBS = [
  "validate",
  "mac-containment",
  "darwin-native",
  "verify-artifact",
];
const HEAD_SUITE = 105739629025;
const BASE_SUITE = 105737343683;

/** The head after its first three jobs finished, the base with all four. */
function threeOfFour() {
  return {
    [SHA3]: JOBS.slice(0, 3).map((name) =>
      suiteCheck(name, SHA3, HEAD_SUITE, T0)
    ),
    [SHA1]: JOBS.map((name) => suiteCheck(name, SHA1, BASE_SUITE, T0)),
  };
}

async function assertRollbackParses(writes: RepairStateSnapshotV1[]) {
  if (!GEN80) return;
  assert.ok(writes.length > 0);
  for (const written of writes) await assertGen80Parses(written);
}

/** R80's own launcher reads `work`'s park as its pre-review pending park. */
async function assertR80ReadsPark(
  after: RepairStateSnapshotV1,
  work: ReturnType<typeof taskRecord>,
) {
  if (!GEN80) return;
  const loaded = await loadGen80Modules(["ops/hosted-autonomy-ci-first.ts"]);
  try {
    const [r80] = loaded.modules as [
      { preReviewCiParked: typeof preReviewCiParked },
    ];
    assert.equal(
      r80.preReviewCiParked(after, work),
      true,
      "R80's launcher reads the park as its own pending park",
    );
  } finally {
    await loaded.dispose();
  }
}

Deno.test("CI first: a head with 3 of 4 expected check names waits uncharged, is never reviewed, and parks after six hours naming the absent check", async () => {
  const { rig, charges, writes } = await ciFirstRig("cf-cover-wait", {
    hosted: true,
    checks: threeOfFour(),
  });
  try {
    await rig.run();
    let work = taskRecord(await rig.snapshot());
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.equal(work.wait?.reason, "ci_pending");
    const since = work.wait!.since;
    rig.clock.advance(5 * 60_000 + 1);
    await rig.run();
    work = taskRecord(await rig.snapshot());
    assert.equal(work.wait?.since, since, "the wait keeps its start");
    rig.clock.advance(6 * HOUR);
    await rig.run();
    const after = await rig.snapshot();
    work = taskRecord(after);
    assert.equal(work.nextStep, "blocked");
    assert.equal(
      work.blocker?.message,
      "CI did not finish before review within 6 hours: verify-artifact(absent)",
    );
    assert.equal(work.counters.reviewRounds, 0);
    assert.equal(work.counters.retries, 0);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.deepEqual(after.reservations, charges, "nothing charged");
    assert.equal(rig.model.requests.length, 0);
    // The launcher reads it as the pre-review pending park it re-admits.
    assert.equal(preReviewCiParked(after, work), true);
    await assertRollbackParses(writes);
    await assertR80ReadsPark(after, work);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: the head is reviewed once GitHub creates its fourth check", async () => {
  const { rig, setChecks, writes } = await ciFirstRig("cf-cover-later", {
    checks: threeOfFour(),
  });
  try {
    await rig.run();
    assert.equal(rig.github.calls.includes("requestReview"), false);
    setChecks(
      SHA3,
      JOBS.map((name) => suiteCheck(name, SHA3, HEAD_SUITE, T0)),
    );
    rig.clock.advance(5 * 60_000 + 1);
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.reviewRounds, 1);
    assert.equal(reviewCharges(after).length, 1);
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    await assertRollbackParses(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a head is not held for base suites it shares no name with (the scheduled dispatch runs on sentinel development)", async () => {
  // Live sentinel development 9a1b1d924: ci.yml's push run (`test-local`)
  // and the five-minute `dispatch` schedule, each its own suite. A pull
  // request head runs ci.yml alone.
  const { rig } = await ciFirstRig("cf-cover-self", {
    checks: {
      [SHA3]: [suiteCheck("test-local", SHA3, 900, T0)],
      [SHA1]: [
        suiteCheck("test-local", SHA1, 100, T0),
        suiteCheck("dispatch", SHA1, 200, T0),
        suiteCheck("dispatch", SHA1, 201, T0 + 300_000),
      ],
    },
  });
  try {
    await rig.run();
    const work = taskRecord(await rig.snapshot());
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.reviewRounds, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

/** The sentinel self scope (the no-App owner identity). */
const SELF: RepositoryIdentityV1 = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

/**
 * One green `test-local` head (a pull request head runs ci.yml alone) on a
 * base whose check reads go through the REAL port over the live sentinel
 * `development` listing of `live`. The strict check read refuses that
 * listing (78-character `matrix_cell` runs, label bound 64): before this fix
 * the coverage read made of it deferred the head forever, with no write.
 */
async function liveBaseCase(
  prefix: string,
  repository: RepositoryIdentityV1,
  live: GitSha,
) {
  const self = repository === SELF;
  const id = self ? "issue-152" : TASK;
  const { rig, charges, writes } = await ciFirstRig(prefix, {
    hosted: true,
    ...(self ? { identity: { repository, id, issue: 152 } } : {}),
    checks: { [SHA3]: [suiteCheck("test-local", SHA3, 105900000001, T0)] },
  });
  try {
    const transport = routeLiveDevelopment(rig.github, repository, {
      [SHA1]: live,
    }).get(SHA1)!;
    const strict = await rig.github.readChecks(SHA1);
    assert.equal(strict.ok, false);
    assert.match(
      strict.ok ? "" : strict.error.detail,
      /exceeds contract bounds/,
    );
    const probed = transport.requests.length;
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after, id);
    assert.equal(work.repository.name, repository.name);
    assert.equal(work.blocker, null, JSON.stringify(work.blocker));
    assert.equal(work.nextStep, "review", JSON.stringify(work.wait));
    assert.equal(work.counters.reviewRounds, 1);
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    assert.equal(reviewCharges(after, id).length, 1);
    assert.equal(
      after.reservations.length,
      charges.length + 1,
      "the review charge only",
    );
    await assertRollbackParses(writes);
    return transport.requests.slice(probed);
  } finally {
    await rig.ctx.cleanup();
  }
}

const LIVE_BASES = [
  { label: "L80 9a1b1d924", live: LIVE_L80 },
  { label: "tip 3f041b46d", live: LIVE_TIP },
];

for (const { label, live } of LIVE_BASES) {
  const tag = live.slice(0, 9);
  Deno.test(`CI first: a green self head on the live sentinel development ${label} (78-character matrix_cell runs) is reviewed; the self scope reads no base`, async () => {
    const reads = await liveBaseCase(`cf-cover-self-${tag}`, SELF, live);
    assert.deepEqual(reads, [], "the self gate reads no base");
  });

  Deno.test(`CI first: a green foreign head on a base carrying the live sentinel ${label} listing is reviewed through the real port's coverage read`, async () => {
    const reads = await liveBaseCase(`cf-cover-foreign-${tag}`, REPO, live);
    assert.ok(reads.length > 0, "the base was read through the real port");
    for (const request of reads) {
      assert.match(request.url, /\/check-runs\?/, "no commit-status read");
    }
  });
}

for (const { label, live } of LIVE_BASES) {
  Deno.test(`CI first: a red self head on the live sentinel development ${label} is attributed through a name-filtered base read, never deferred forever`, async () => {
    // Round-2 finding: the red path read the whole base strictly, and the
    // 78-character `matrix_cell (<cellId>)` runs refused it, so a red self
    // head was deferred every cycle with no write, no CI fix and no park.
    const id = "issue-152";
    const { rig, writes } = await ciFirstRig(
      `cf-red-self-${live.slice(0, 9)}`,
      {
        hosted: true,
        identity: { repository: SELF, id, issue: 152 },
        checks: {
          [SHA3]: [{
            ...suiteCheck("test-local", SHA3, 105900000001, T0),
            conclusion: "failure",
          }],
        },
      },
    );
    try {
      routeLiveDevelopment(rig.github, SELF, { [SHA1]: live });
      const strict = await rig.github.readChecks(SHA1);
      assert.equal(strict.ok, false, "the unfiltered base read still refuses");
      const port: GitHubPort = rig.github;
      const filtered = await port.readChecks(SHA1, new Set(["test-local"]));
      assert.ok(filtered.ok, JSON.stringify(filtered));
      assert.deepEqual(
        filtered.ok ? filtered.value.checks.map((check) => check.name) : [],
        ["test-local"],
      );
      await rig.run();
      const after = await rig.snapshot();
      const work = taskRecord(after, id);
      assert.ok(writes.length > 0, "the red head was routed, not deferred");
      assert.notEqual(work.nextStep, "review");
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  });
}

Deno.test("CI first: an unreadable base listing holds a complete green head in a bounded wait and parks naming it: no review, nothing charged", async () => {
  const { rig, charges, writes } = await ciFirstRig("cf-cover-unread", {
    hosted: true,
    checks: {
      [SHA3]: JOBS.map((name) => suiteCheck(name, SHA3, HEAD_SUITE, T0)),
    },
  });
  // Every check read of the base fails, as a rate-limited listing does.
  const refused = () =>
    Promise.resolve(portError("unavailable", "check runs unavailable"));
  const readChecks = rig.github.readChecks.bind(rig.github);
  const readCheckSuites = rig.github.readCheckSuites.bind(rig.github);
  rig.github.readChecks = (head: GitSha) =>
    head === SHA1 ? refused() : readChecks(head);
  rig.github.readCheckSuites = (head: GitSha) =>
    head === SHA1 ? refused() : readCheckSuites(head);
  try {
    await rig.run();
    let work = taskRecord(await rig.snapshot());
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.equal(
      work.wait?.reason,
      "ci_pending",
      "a bounded wait, not silence",
    );
    const since = work.wait!.since;
    rig.clock.advance(5 * 60_000 + 1);
    await rig.run();
    work = taskRecord(await rig.snapshot());
    assert.equal(work.wait?.since, since, "the wait keeps its start");
    rig.clock.advance(6 * HOUR);
    await rig.run();
    const after = await rig.snapshot();
    work = taskRecord(after);
    assert.equal(work.nextStep, "blocked");
    assert.equal(
      work.blocker?.message,
      "CI did not finish before review within 6 hours: base checks unreadable",
    );
    assert.equal(work.counters.reviewRounds, 0);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.deepEqual(after.reservations, charges, "nothing charged");
    assert.equal(preReviewCiParked(after, work), true);
    await assertRollbackParses(writes);
    await assertR80ReadsPark(after, work);
  } finally {
    await rig.ctx.cleanup();
  }
});
