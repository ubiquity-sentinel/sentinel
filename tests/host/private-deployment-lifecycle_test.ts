/**
 * The private role's issue-to-merge half through real consumers: a copy of
 * this tree whose committed private entry is bound (test ids) runs
 * `private-deployment-lifecycle-cases.ts` as the private deployment.
 */
import assert from "node:assert/strict";
import { runAsPrivateDeployment } from "./private-deployment-copy.ts";

Deno.test("private role: a bound copy verifies reviewed merges and grants six of seven ready issues", async () => {
  const { code, output } = await runAsPrivateDeployment(
    "tests/host/private-deployment-lifecycle-cases.ts",
    "private-lifecycle-",
  );
  assert.equal(code, 0, output);
  assert.match(output, /ok \| 3 passed \| 0 failed/);
});
