/**
 * Owner, 2026-11-23: "Remove the special policy. We will deploy a private
 * sentinel for all private repos". The accepted CI-minute policy holds no
 * target row, so every production composition is inert: the runtime's and
 * the launcher's coordinator is `inactive` for every repository and never
 * composes the private CI capability, a store, a read or a write (the ledger
 * history on `sentinel-state/ci-minutes` stays as it is). A public target's
 * effect is `inactive` exactly as before (it never had a row); prospector's
 * and auth.ubq.fi's are now `inactive` too, so they are worked like any
 * other target (`private-deployment-lifecycle_test.ts` merges both).
 */
import assert from "node:assert/strict";
import {
  acceptedCiMinutePolicy,
  type CiEffectV1,
  ciMinutePolicyInactive,
  INACTIVE_CI_MINUTE_POLICY,
} from "../../src/contracts/ci-minute-budget.ts";
import { createCiMinuteController } from "../../src/budget/ci-minutes.ts";
import {
  composePrivateCiMinutes,
  runtimeCiMinutes,
} from "../../src/host/hosted-app-principal.ts";
import { retiredCiMinutePolicy } from "../state/retired-ci-minute-policy.ts";

const effect = (owner: string, name: string): CiEffectV1 => ({
  repository: { owner, name, installationId: 155687488 },
  kind: "head_push",
  head: "a".repeat(40),
  base: "b".repeat(40),
  ref: "refs/heads/sentinel/repair/issue-1",
  pr: null,
});
const REPOSITORIES = [
  ["ubiquity", "prospector"],
  ["ubiquity", "auth.ubq.fi"],
  ["ubiquity", "passport.ubq.fi"],
  ["ubiquity", "ai.ubq.fi"],
] as const;

function untouchable() {
  let touched = 0;
  const fail = () => {
    touched++;
    throw new Error("an inert CI-minute policy touched its machinery");
  };
  return { fail, touched: () => touched };
}

Deno.test("CI-minute policy removed: no row, and every composition is inactive and touches nothing", async () => {
  assert.deepEqual(acceptedCiMinutePolicy().targets, []);
  assert.deepEqual(INACTIVE_CI_MINUTE_POLICY.targets, []);
  assert.equal(ciMinutePolicyInactive(acceptedCiMinutePolicy()), true);
  // The machinery itself is unchanged: the retired rows still activate it.
  assert.equal(ciMinutePolicyInactive(retiredCiMinutePolicy()), false);

  const { fail, touched } = untouchable();
  const launcher = composePrivateCiMinutes({
    policy: acceptedCiMinutePolicy(),
    clock: { now: fail },
    scratch: "/not-used/ci-minutes-private",
    deadlineAt: 0,
    authority: fail,
    billingBasis: fail,
  });
  const runtime = runtimeCiMinutes(
    { now: fail },
    "/not-used",
    fail,
    0,
    {
      sourcePathBySlug: new Map(),
      trustedPath: "/usr/bin",
      gitExecutable: "/usr/bin/git",
    },
  );
  const controller = createCiMinuteController({
    policy: acceptedCiMinutePolicy(),
    clock: { now: fail },
    store: { read: fail, readPrior: fail, write: fail },
    authorizePolicy: fail,
    resolve: fail,
    observe: fail,
  });
  for (const coordinator of [launcher, runtime, controller]) {
    assert.equal(coordinator.active, false);
    assert.deepEqual(await coordinator.reconcile(0), { kind: "inactive" });
    for (const [owner, name] of REPOSITORIES) {
      assert.deepEqual(
        await coordinator.reserve(effect(owner, name), 0),
        { kind: "inactive" },
        `${owner}/${name}`,
      );
    }
  }
  assert.equal(touched(), 0);
});

Deno.test("CI-minute policy removed: a public target's CI effect is inactive exactly as before", async () => {
  // Before: the retired rows named only prospector and passport, so a public
  // target's effect returned `inactive` before any read; after: the same.
  const { fail, touched } = untouchable();
  const before = composePrivateCiMinutes({
    policy: retiredCiMinutePolicy(),
    clock: { now: fail },
    scratch: "/not-used/ci-minutes-private",
    deadlineAt: 0,
    authority: fail,
    billingBasis: fail,
  });
  const after = composePrivateCiMinutes({
    policy: acceptedCiMinutePolicy(),
    clock: { now: fail },
    scratch: "/not-used/ci-minutes-private",
    deadlineAt: 0,
    authority: fail,
    billingBasis: fail,
  });
  for (const name of ["ai.ubq.fi", "work.ubq.fi", "pay.ubq.fi"]) {
    const was = await before.reserve(effect("ubiquity", name), 0);
    const is = await after.reserve(effect("ubiquity", name), 0);
    assert.deepEqual(was, { kind: "inactive" });
    assert.deepEqual(is, was);
  }
  assert.equal(touched(), 0);
});
