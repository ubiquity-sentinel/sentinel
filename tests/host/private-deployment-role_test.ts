/**
 * The private role through real consumers: a copy of this tree whose committed
 * private entry is bound (test ids), run as the private deployment (GitHub's
 * GITHUB_REPOSITORY), executes `private-deployment-role-cases.ts`
 * (`private-deployment-copy.ts` builds the copy). Only the runtime rig's own
 * literal self identity is renamed in the copy; production source is the
 * committed source plus the binding edits.
 */
import assert from "node:assert/strict";
import { runAsPrivateDeployment } from "./private-deployment-copy.ts";

Deno.test("private role: a bound, wired copy runs as its own deployment and never as the public one", async () => {
  const { code, output } = await runAsPrivateDeployment(
    "tests/host/private-deployment-role-cases.ts",
    "private-role-",
  );
  assert.equal(code, 0, output);
  assert.match(output, /ok \| 7 passed \| 0 failed/);
});
