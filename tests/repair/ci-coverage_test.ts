/**
 * Required CI coverage (sentinel issue #154): a head's checks read green only
 * once the head reports every check name of each base check suite it shares
 * a name with. The rule itself, the absent-check labels a wait or park names,
 * the check suite id the runtime port now reads from the wire, and the port's
 * lenient coverage read of a base (`readCheckSuites`) over the live sentinel
 * `development` listings the strict read refuses.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import { missingExpectedChecks } from "../../src/repair/ci-coverage.ts";
import {
  absentCheckLabels,
  MAX_CI_CORRECTION_CHECKS,
  preReviewAbsentDetail,
} from "../../src/repair/ci-rejection.ts";
import { CI_PRE_REVIEW_PENDING_PREFIX } from "../../src/repair/ci-first-policy.ts";
import {
  checkRunWire,
  checksPageWire,
  commitStatusWire,
  httpRespond,
  makePort,
  SHA1,
  statusesPageWire,
} from "../github/helpers.ts";
import { SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  LIVE_GAP,
  LIVE_L80,
  LIVE_TIP,
  liveDevelopmentPort,
  liveDevelopmentWire,
  liveGapChecks,
  suiteCheck,
} from "./ci-coverage-fixtures.ts";

const HEAD = SHA3 as GitSha;
const BASE = SHA2 as GitSha;

Deno.test("CI coverage: a head with 3 of 4 expected check names misses the fourth", () => {
  const base = ["a", "b", "c", "d"].map((name) =>
    suiteCheck(name, BASE, 20, T0)
  );
  const head = ["a", "b", "c"].map((name) => suiteCheck(name, HEAD, 10, T0));
  assert.deepEqual(missingExpectedChecks(head, base), ["d"]);
  assert.deepEqual(
    missingExpectedChecks([...head, suiteCheck("d", HEAD, 10, T0)], base),
    [],
  );
});

Deno.test("CI coverage: the live verify-artifact gap misses verify-artifact until GitHub creates it", () => {
  const tip = liveGapChecks("tip", LIVE_GAP.tip);
  assert.deepEqual(
    missingExpectedChecks(liveGapChecks("gap", LIVE_GAP.head), tip),
    ["verify-artifact"],
  );
  assert.deepEqual(
    missingExpectedChecks(liveGapChecks("complete", LIVE_GAP.head), tip),
    [],
  );
});

Deno.test("CI coverage: a base workflow the head never runs is not expected (scheduled dispatch on sentinel development)", () => {
  // Live sentinel development 9a1b1d924: `test-local` from ci.yml's push run
  // and one `dispatch` run per five-minute schedule, each in its own suite.
  // A pull request head runs ci.yml only; requiring `dispatch` would hold
  // every self head forever.
  const base = [
    suiteCheck("test-local", BASE, 1, T0),
    suiteCheck("dispatch", BASE, 2, T0),
    suiteCheck("dispatch", BASE, 3, T0 + 300_000),
  ];
  const head = [suiteCheck("test-local", HEAD, 9, T0)];
  assert.deepEqual(missingExpectedChecks(head, base), []);
});

Deno.test("CI coverage: base checks without a suite (commit statuses) are never expected", () => {
  const status: GitHubCheckV1 = {
    name: "deploy/preview",
    status: "completed",
    conclusion: "success",
    head: BASE,
    startedAt: T0,
    completedAt: T0 + 1,
  };
  assert.deepEqual(
    missingExpectedChecks([suiteCheck("validate", HEAD, 9, T0)], [
      status,
      suiteCheck("validate", BASE, 1, T0),
    ]),
    [],
  );
  // No suite anywhere (the fakes most rigs use): nothing is expected.
  assert.deepEqual(missingExpectedChecks([], [status]), []);
});

Deno.test("CI coverage: absent checks are labelled, sanitised and bounded like every other CI label", () => {
  assert.equal(
    absentCheckLabels(["verify-artifact"]),
    "verify-artifact(absent)",
  );
  assert.equal(
    preReviewAbsentDetail(["verify-artifact"]),
    `${CI_PRE_REVIEW_PENDING_PREFIX}verify-artifact(absent)`,
  );
  const many = Array.from({ length: 12 }, (_, index) => `job-${index}`);
  assert.equal(
    absentCheckLabels(many).split(", ").length,
    MAX_CI_CORRECTION_CHECKS,
  );
  assert.equal(absentCheckLabels([]), "no checks reported");
  assert.equal(absentCheckLabels(null), "base checks unreadable");
  assert.doesNotMatch(absentCheckLabels(["@codex review"]), /@/);
});

Deno.test("readChecks: the strict CI read stays R80's: it reads no check suite, and a malformed suite is not its concern", async () => {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        `/repos/ubiquity-sentinel/sentinel/commits/${SHA1}/check-runs?per_page=100&page=1`,
        200,
        checksPageWire([
          checkRunWire({ name: "validate", check_suite: { id: 105739629025 } }),
          checkRunWire({ name: "legacy", check_suite: { id: "7" } }),
        ]),
      ),
      httpRespond(
        "GET",
        `/repos/ubiquity-sentinel/sentinel/commits/${SHA1}/statuses?per_page=100&page=1`,
        200,
        statusesPageWire([commitStatusWire({ context: "deploy" })]),
      ),
    ],
  });
  const result = await port.readChecks(SHA1);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value.checks.map((check) => check.name), [
    "validate",
    "legacy",
    "deploy",
  ]);
  for (const check of result.value.checks) {
    assert.equal("suite" in check, false);
  }
});

/** The sentinel self scope (the no-App owner identity). */
const SELF = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

for (
  const [live, runs, long] of [[LIVE_L80, 22, 7], [LIVE_TIP, 75, 33]] as const
) {
  Deno.test(`readCheckSuites: the live sentinel development ${live.slice(0, 9)} listing (${long} runs past the label bound) reads as names and suites; the strict read refuses it`, async () => {
    const { port, transport } = liveDevelopmentPort(SELF, live, live);
    const strict = await port.readChecks(live);
    assert.equal(strict.ok, false);
    assert.match(
      strict.ok ? "" : strict.error.detail,
      /exceeds contract bounds/,
    );
    const before = transport.requests.length;
    const read = await port.readCheckSuites(live);
    assert.ok(read.ok, JSON.stringify(read));
    if (!read.ok) return;
    assert.equal(read.value.head, live);
    assert.equal(read.value.checks.length, runs);
    assert.equal(
      read.value.checks.filter((check) => check.name.length > 64).length,
      long,
    );
    const wire = liveDevelopmentWire(live);
    assert.deepEqual(
      read.value.checks,
      wire.map((run) => ({
        name: run.name,
        suite: (run.check_suite as { id: number }).id,
      })),
    );
    // One check-run page; commit statuses (never expected) are not read.
    const requests = transport.requests.slice(before);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/check-runs\?per_page=100&page=1$/);
    // A self pull request head runs ci.yml alone: `test-local` covers it.
    assert.deepEqual(
      missingExpectedChecks(
        [suiteCheck("test-local", HEAD, 9001, T0)],
        read.value.checks,
      ),
      [],
    );
  });
}

Deno.test("readCheckSuites: exact head, exact suite, bounded items; a run without a suite expects nothing", async () => {
  const path =
    `/repos/ubiquity-sentinel/sentinel/commits/${SHA1}/check-runs?per_page=100&page=1`;
  const read = (runs: unknown[], maxItems?: number) =>
    makePort({
      script: [httpRespond("GET", path, 200, checksPageWire(runs))],
      ...(maxItems === undefined ? {} : { maxItems }),
    }).port.readCheckSuites(SHA1);
  const long = `matrix_cell (${"a".repeat(64)})`;
  const ok = await read([
    checkRunWire({ name: long, check_suite: { id: 7 } }),
    checkRunWire({ name: "legacy" }),
    checkRunWire({ name: "nulled", check_suite: null, status: "odd" }),
  ]);
  assert.ok(ok.ok, JSON.stringify(ok));
  if (!ok.ok) return;
  assert.deepEqual(ok.value.checks, [
    { name: long, suite: 7 },
    { name: "legacy", suite: null },
    { name: "nulled", suite: null },
  ]);
  const drifted = await read([checkRunWire({ head_sha: SHA2 })]);
  assert.equal(drifted.ok, false, "a run of another commit is not this base's");
  const malformed = await read([checkRunWire({ check_suite: { id: "7" } })]);
  assert.equal(malformed.ok, false, "a malformed suite is not evidence");
  const unnamed = await read([checkRunWire({ name: "" })]);
  assert.equal(unnamed.ok, false);
  const bounded = await read([checkRunWire(), checkRunWire()], 1);
  assert.equal(bounded.ok, false, "the item bound stays");
});
