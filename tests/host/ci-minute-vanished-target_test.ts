/**
 * The (now inert) CI-minute reconciler's coverage rule. It lists each policy
 * target's runs by name, so a target whose listing cannot be read (a renamed
 * repository answers a redirect, which is never followed; a name outside the
 * token is not found) keeps every reconciliation incomplete, turn after
 * turn, while a readable target's discovery finishes; the controller holds
 * every CI effect while a reconciliation is incomplete (`held`,
 * `reconciliation`). That is how the vanished `ubiquity/passport.ubq.fi` row
 * would have held prospector on the private deployment (2026-11-22). The
 * owner then removed the special policy (2026-11-23): the accepted policy has
 * no row, so no production composition reconciles at all
 * (`ci-minute-policy-removed_test.ts`); this rule stays true of the machinery.
 */
import assert from "node:assert/strict";
import { createCiMinuteReconciler } from "../../ops/ci-minute-reconciliation.ts";
import {
  acceptedCiMinutePolicy,
  ciPolicyDigest,
  parseCiMinuteLedger,
} from "../../src/contracts/ci-minute-budget.ts";
import type {
  CiMinuteLedgerV1,
  CiMinuteObservationV1,
  CiMinutePolicyV1,
} from "../../src/contracts/ci-minute-budget.ts";

const NOW = Date.UTC(2028, 0, 2);

function fixture(vanished: boolean) {
  const policy: CiMinutePolicyV1 = {
    ...acceptedCiMinutePolicy(),
    targets: [
      {
        owner: "fixture",
        name: "project",
        repositoryId: 101,
        ceilingMinutes: 25,
      },
      {
        owner: "fixture",
        name: "renamed",
        repositoryId: 102,
        ceilingMinutes: 35,
      },
    ],
  };
  let now = NOW;
  let ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: "2028-01",
    policyDigest: ciPolicyDigest(policy),
    updatedAt: now,
    sequence: 0,
    baselineMinutes: 1450,
    watermark: null,
    reservations: [],
    observed: [],
    bootstrap: {
      kind: "conservative_unknown_history",
      month: "2028-01",
      floorMinutes: 1450,
      createdAt: now,
      policyDigest: ciPolicyDigest(policy),
    },
  };
  const listed: string[] = [];
  const request = async (path: string) => {
    await Promise.resolve();
    const url = new URL("https://fixture.invalid" + path);
    listed.push(url.pathname);
    if (url.pathname === "/repos/fixture/project/actions/runs") {
      return { total_count: 0, workflow_runs: [] };
    }
    if (url.pathname === "/repos/fixture/renamed/actions/runs") {
      // The client's answer to a redirect (renamed) or a 404 (outside the
      // token): no listing.
      return vanished ? null : { total_count: 0, workflow_runs: [] };
    }
    return null;
  };
  const turn = async (): Promise<CiMinuteObservationV1> => {
    const result = await createCiMinuteReconciler({
      policy,
      request,
      clock: { now: () => now },
    })("2028-01", now + 60_000, ledger);
    assert.ok(result);
    ledger = parseCiMinuteLedger({
      ...ledger,
      updatedAt: now,
      sequence: ledger.sequence + 1,
      watermark: result.complete ? result.watermark : ledger.watermark,
      progress: result.progress,
      catalog: result.catalog,
      completedAttempts: [
        ...new Set([
          ...(ledger.completedAttempts ?? []),
          ...(result.completedAttempts ?? []),
        ]),
      ],
      proofs: [...(ledger.proofs ?? []), ...result.jobs],
    });
    now += 300_000;
    return result;
  };
  return { turn, listed };
}

Deno.test("CI reconciler: an unreadable policy target keeps every turn incomplete; readable targets complete", async () => {
  const readable = fixture(false);
  let completed = false;
  for (let i = 0; i < 10 && !completed; i++) {
    completed = (await readable.turn()).complete;
  }
  assert.ok(completed, "both listings readable: the pass completes");

  const vanished = fixture(true);
  for (let i = 0; i < 10; i++) {
    assert.equal((await vanished.turn()).complete, false, `turn ${i}`);
  }
  assert.ok(vanished.listed.includes("/repos/fixture/project/actions/runs"));
  assert.ok(vanished.listed.includes("/repos/fixture/renamed/actions/runs"));
});
