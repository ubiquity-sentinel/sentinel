/**
 * The private role's launcher installation through the production supervisor
 * and install API: a bound copy runs `private-deployment-install-cases.ts`
 * as the private deployment.
 */
import assert from "node:assert/strict";
import { runAsPrivateDeployment } from "./private-deployment-copy.ts";

Deno.test("private role: a bound copy installs only a launcher with green private CI and otherwise starts nothing", async () => {
  const { code, output } = await runAsPrivateDeployment(
    "tests/host/private-deployment-install-cases.ts",
    "private-install-",
  );
  assert.equal(code, 0, output);
  assert.match(output, /ok \| 2 passed \(4 steps\) \| 0 failed/);
});
