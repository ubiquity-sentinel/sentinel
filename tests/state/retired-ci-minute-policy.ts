/**
 * The CI-minute policy rows the owner removed on 2026-11-23 ("Remove the
 * special policy. We will deploy a private sentinel for all private repos"),
 * kept ONLY as a test fixture so the inert machinery (controller, store,
 * reconciler, private CI composition) stays tested. Production holds no row
 * (`acceptedCiMinutePolicy().targets` is empty), so no live code reads these.
 */
import type {
  CiEffectFactsV1,
  CiMinutePolicyV1,
  CiMinuteSourcePolicyV1,
} from "../../src/contracts/ci-minute-budget.ts";
import { acceptedCiMinutePolicy } from "../../src/contracts/ci-minute-budget.ts";
import { verifyCiMinuteSchedulingBasis } from "../../src/budget/ci-minutes.ts";

const RETIRED_TARGETS: CiMinuteSourcePolicyV1["targets"] = [
  {
    owner: "ubiquity",
    name: "prospector",
    repositoryId: 1337190500,
    ceilingMinutes: 25,
    workflowBlob: "bacb73da71714a27d76918771d06ff4ce1f45b82",
    job: "validation",
    runner: "ubuntu-latest",
    timeoutMinutes: 20,
  },
  {
    owner: "ubiquity",
    name: "passport.ubq.fi",
    repositoryId: 1254699258,
    ceilingMinutes: 35,
    workflowBlob: "f2c61d693d8439a7f42b47d35ebaedb37173b1c7",
    job: "deno",
    runner: "ubuntu-latest",
    timeoutMinutes: 30,
  },
];

/** The accepted policy as it was before 2026-11-23, rows included. */
export function retiredCiMinutePolicy(): CiMinuteSourcePolicyV1 {
  return structuredClone({
    ...acceptedCiMinutePolicy(),
    targets: RETIRED_TARGETS,
  });
}

/** The scheduling-basis check against the retired rows (tests only). */
export function retiredBasis(
  policy: CiMinutePolicyV1,
  deadline: number,
  facts?: CiEffectFactsV1,
): Promise<boolean> {
  return verifyCiMinuteSchedulingBasis(
    policy,
    deadline,
    facts,
    retiredCiMinutePolicy(),
  );
}
