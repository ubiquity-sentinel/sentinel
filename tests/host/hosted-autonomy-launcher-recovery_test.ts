/**
 * Launcher recovery for runtime-mismatch preserved candidates through the
 * real maintenance consumer: an expired or unlisted producer plan is a typed
 * skip that writes nothing and lets the later passes run, and a candidate
 * whose exact deterministic preservation ref already exists is restored
 * without any matrix artifact, leaving the same record as artifact recovery.
 */
import { modernRecoveryScenario } from "./hosted-autonomy-modern-scenario.ts";

Deno.test("blocked candidate recovery: an expired producer plan is a typed skip that writes nothing", () =>
  modernRecoveryScenario(true, false, "expired-plan"));

Deno.test("blocked candidate recovery: an unlisted producer plan is a typed skip that writes nothing", () =>
  modernRecoveryScenario(true, false, "unlisted-plan"));

Deno.test("blocked candidate recovery: an existing exact preservation ref restores the record without artifacts", () =>
  modernRecoveryScenario(true, false, "existing-ref"));

Deno.test("blocked candidate recovery: a preservation ref at another head is left untouched", () =>
  modernRecoveryScenario(true, false, "existing-ref-conflict"));

Deno.test("blocked candidate recovery: a custody-parked candidate on its exact preservation ref is restored", () =>
  modernRecoveryScenario(true, false, "existing-ref-parked"));
