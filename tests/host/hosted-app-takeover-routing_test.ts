import assert from "node:assert/strict";
import { readHostedAppTakeoverRouting } from "../../src/host/hosted-app-takeover-routing.ts";
import { principalHostFixture } from "./hosted-app-principal-fixtures.ts";

Deno.test("hosted takeover routing: intentional unconfigured runtime stays inert without source or native requests", async () => {
  const rig = await principalHostFixture();
  try {
    let sourceReads = 0;
    const source = {
      ...rig.source,
      process: {
        run: () => {
          sourceReads++;
          throw new Error("unconfigured deployment must not inspect source");
        },
      },
    };
    // Model the intentional unconfigured deployment independently of shipped profiles.
    assert.deepEqual(await readHostedAppTakeoverRouting(source, []), {
      status: "inactive",
    });
    assert.equal(sourceReads, 0);
    assert.equal(rig.model.calls.length, 0);
  } finally {
    await rig.close();
  }
});

Deno.test("hosted takeover routing: actual source admission is independent of App grants and the custody floor", async () => {
  const rig = await principalHostFixture();
  try {
    assert.equal(rig.capability.existingPr.custodyActivated, true);
    assert.deepEqual(
      await readHostedAppTakeoverRouting(rig.source, rig.profiles),
      { status: "inactive" },
    );
    rig.capability.takeover.activated = true;
    rig.capability.existingPr.custodyActivated = false;
    await rig.write(
      rig.launcher,
      "src/host/hosted-custody-capability.json",
      JSON.stringify(rig.capability),
    );
    await rig.commitLauncher();
    assert.deepEqual(
      await readHostedAppTakeoverRouting(rig.source, rig.profiles),
      { status: "required" },
    );
    assert.equal(
      rig.model.calls.length,
      0,
      "routing has no native or App transport",
    );
    assert.equal(rig.state.repairWrites, 0);
  } finally {
    await rig.close();
  }
});

Deno.test("hosted takeover routing: configured unknown source is restrictive instead of dormant", async (t) => {
  for (
    const scenario of [
      "malformed profiles",
      "unknown code",
      "dirty source",
      "missing admission",
      "invalid admission",
      "invalid rollout",
    ]
  ) {
    await t.step(scenario, async () => {
      const rig = await principalHostFixture();
      try {
        let profiles: unknown = rig.profiles;
        if (scenario === "malformed profiles") profiles = { profiles: [] };
        else if (scenario === "unknown code") {
          rig.profiles[0].codeSha256 = "0".repeat(64);
        } else if (scenario === "dirty source") {
          await rig.write(
            rig.launcher,
            "src/host/hosted-runtime-child.ts",
            "unreviewed\n",
          );
        } else {
          const capability: Record<string, unknown> = structuredClone(
            rig.capability,
          );
          if (scenario === "missing admission") delete capability.takeover;
          if (scenario === "invalid admission") {
            capability.takeover = { activated: "true" };
          }
          const path = scenario === "invalid rollout"
            ? "src/host/hosted-runtime-rollout.json"
            : "src/host/hosted-custody-capability.json";
          await rig.write(
            rig.launcher,
            path,
            JSON.stringify(scenario === "invalid rollout" ? {} : capability),
          );
          await rig.commitLauncher();
        }
        assert.deepEqual(
          await readHostedAppTakeoverRouting(rig.source, profiles),
          { status: "unknown" },
        );
        assert.equal(rig.model.calls.length, 0);
        assert.equal(rig.state.repairWrites, 0);
      } finally {
        await rig.close();
      }
    });
  }
});
