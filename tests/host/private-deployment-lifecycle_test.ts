/** Both committed deployments exercise the same hosted lifecycle cases. */
import assert from "node:assert/strict";
import { HOSTED_CONTROLLER_PROFILES } from "../../src/contracts/hosted-controller-deployment.ts";
import { runDeploymentCases } from "./private-deployment-copy.ts";

for (const { role, repository } of HOSTED_CONTROLLER_PROFILES) {
  Deno.test(`${role} deployment: hosted issue delivery through a reviewed merge`, async () => {
    const { code, output } = await runDeploymentCases(
      "tests/host/private-deployment-lifecycle-cases.ts",
      repository,
    );
    assert.equal(code, 0, output);
    assert.match(output, /ok \| 3 passed \| 0 failed/);
  });
}
