/**
 * The CI-first gate over backup CI evidence (docs/backup-ci-spec.md §11.2,
 * §11.3, §11.6): the real repair loop and `gateReviewOnCi` over real Git
 * state, with a fake GitHub port answering exactly what the runtime check
 * read returns once stand-ins are applied (`backup`) or a peer is attached
 * (`backupPeer`). A green stand-in is reviewed; a red one is the candidate's
 * only against the base's own backup evidence; a provisional red, or a red
 * without base evidence, waits uncharged; a native red against a backup-only
 * base needs the head's own backup peer. All synthetic.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import { isCiFixMarker } from "../../src/repair/ci-first-policy.ts";
import { SHA1, SHA3 } from "../state/helpers.ts";
import {
  check,
  ciFirstRig,
  reviewCharges,
  taskRecord,
} from "./ci-first-rig.ts";

const RECEIPT = "bci1:ubiquity/passport.ubq.fi@aaaaaaaaaaaa:" +
  ".github/workflows/ci.yml#deno:push:a1";

/** What the client returns for a never-started run a receipt stands in for. */
function standIn(
  head: GitSha,
  conclusion: "success" | "failure" | "timed_out",
): GitHubCheckV1 {
  return {
    ...check("deno", head, conclusion),
    backup: {
      receipt: RECEIPT,
      context: "push",
      runnerId: "0123456789abcdef",
      legRunId: 5001,
      legJobId: 6001,
    },
  };
}

/** A never-started run no receipt stands in for (yet). */
function notStarted(head: GitSha): GitHubCheckV1 {
  return { ...check("deno", head, "failure"), neverStarted: true };
}

/** A natively started check carrying the head's backup peer. */
function withPeer(
  native: GitHubCheckV1,
  conclusion: "success" | "failure",
): GitHubCheckV1 {
  return { ...native, backupPeer: { conclusion, receipt: RECEIPT } };
}

async function waitsUncharged(
  prefix: string,
  checks: Record<string, GitHubCheckV1[]>,
): Promise<void> {
  const { rig, charges } = await ciFirstRig(prefix, { hosted: true, checks });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.equal(work.wait?.reason, "ci_pending", JSON.stringify(work.wait));
    assert.equal(work.counters.retries, 0);
    assert.equal(work.counters.reviewRounds, 0);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(rig.model.requests.length, 0);
    assert.deepEqual(after.reservations, charges, "nothing charged");
  } finally {
    await rig.ctx.cleanup();
  }
}

async function marksCiFix(
  prefix: string,
  checks: Record<string, GitHubCheckV1[]>,
): Promise<void> {
  const { rig, charges } = await ciFirstRig(prefix, { hosted: true, checks });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(reviewCharges(after).length, 0);
    assert.deepEqual(after.reservations, charges, "charged at admission only");
    assert.equal(work.nextStep, "work");
    assert.ok(isCiFixMarker(work.wait), JSON.stringify(work.wait));
    assert.equal(work.target.head, SHA3);
  } finally {
    await rig.ctx.cleanup();
  }
}

Deno.test("CI first backup: a green stand-in is reviewed", async () => {
  const { rig } = await ciFirstRig("cf-bk-green", {
    checks: { [SHA3]: [standIn(SHA3, "success")] },
  });
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.reviewRounds, 1);
    assert.equal(reviewCharges(after).length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first backup: a red stand-in on a base whose stand-in is green is the candidate's (CI fix marker)", async () => {
  await marksCiFix("cf-bk-red-green", {
    [SHA3]: [standIn(SHA3, "failure")],
    [SHA1]: [standIn(SHA1, "success")],
  });
});

Deno.test("CI first backup: red stand-ins on head and base back off as base_red, uncharged", async () => {
  const { rig, charges } = await ciFirstRig("cf-bk-red-red", {
    checks: {
      [SHA3]: [standIn(SHA3, "timed_out")],
      [SHA1]: [standIn(SHA1, "failure")],
    },
  });
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "work");
    assert.equal(work.wait?.reason, "backoff");
    assert.equal(work.wait!.until! - work.wait!.since, 30 * 60_000);
    assert.equal(work.counters.retries, 0);
    assert.equal(rig.model.requests.length, 0);
    assert.deepEqual(after.reservations, charges);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first backup: a red stand-in without base evidence waits unattributed", async () => {
  // The base never started and holds no receipt yet (the planner schedules
  // its unit); a natively green base without a backup peer is no like-for-
  // like evidence either.
  await waitsUncharged("cf-bk-no-base", {
    [SHA3]: [standIn(SHA3, "failure")],
    [SHA1]: [notStarted(SHA1)],
  });
  await waitsUncharged("cf-bk-native-base", {
    [SHA3]: [standIn(SHA3, "failure")],
    [SHA1]: [check("deno", SHA1, "success")],
  });
});

Deno.test("CI first backup: a provisional red (no confirmation yet) waits uncharged, never parked red", async () => {
  await waitsUncharged("cf-bk-provisional", {
    [SHA3]: [notStarted(SHA3)],
    [SHA1]: [standIn(SHA1, "success")],
  });
});

Deno.test("CI first backup: a native head red against a backup-only base needs the head's peer", async () => {
  // No peer (or a green peer): unattributed, the planner schedules the peer.
  await waitsUncharged("cf-bk-native-nopeer", {
    [SHA3]: [check("deno", SHA3, "failure")],
    [SHA1]: [standIn(SHA1, "success")],
  });
  await waitsUncharged("cf-bk-native-greenpeer", {
    [SHA3]: [withPeer(check("deno", SHA3, "failure"), "success")],
    [SHA1]: [standIn(SHA1, "success")],
  });
  // A red peer against the base's green stand-in: the candidate's.
  await marksCiFix("cf-bk-native-redpeer", {
    [SHA3]: [withPeer(check("deno", SHA3, "failure"), "failure")],
    [SHA1]: [standIn(SHA1, "success")],
  });
});
