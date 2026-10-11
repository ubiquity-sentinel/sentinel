import { historicalC63Scenario } from "./hosted-autonomy-c63-scenario.ts";
import { modernRecoveryScenario } from "./hosted-autonomy-modern-scenario.ts";

Deno.test("current settled modern wave: failed receipt and real candidate recover before historical rejection", () =>
  modernRecoveryScenario());

Deno.test("prior ordinary history: newer healthy proof preserves failed result and real candidate recovery", () =>
  modernRecoveryScenario(true));

Deno.test("native maintenance main: joined CAS expiry and custody drift retain failed applied-head accounting", () =>
  modernRecoveryScenario(true, true));

Deno.test("C63 historical recovery: exact evidenced cells settle through normal consumer before maintenance", () =>
  historicalC63Scenario(false));

Deno.test("C63 first-pass recovery: nineteen charged admissions retain exact historical custody", () =>
  historicalC63Scenario(true));

Deno.test("C63 current plan nonmembership: production maintenance factory still drains retained old cells", () =>
  historicalC63Scenario(false, true));

Deno.test("C63 historical recovery: an already reconciled row never blocks the pending ones", () =>
  historicalC63Scenario(true, false, true));
