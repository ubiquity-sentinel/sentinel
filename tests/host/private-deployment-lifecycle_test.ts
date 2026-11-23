/**
 * The private role's issue-to-merge half through real consumers: a copy of
 * this tree whose committed private entry is bound (test ids) runs
 * `private-deployment-lifecycle-cases.ts` as the private deployment.
 */
import assert from "node:assert/strict";
import { runAsPrivateDeployment } from "./private-deployment-copy.ts";

Deno.test("private role: a bound copy takes a private target's issue from intake to a reviewed merge", async () => {
  const { code, output } = await runAsPrivateDeployment(
    "tests/host/private-deployment-lifecycle-cases.ts",
    "private-lifecycle-",
  );
  assert.equal(code, 0, output);
  assert.match(output, /ok \| 2 passed \| 0 failed/);
});
