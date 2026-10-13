import assert from "node:assert/strict";

Deno.test("operator nonce workflow contract is optional and preserves empty-input behavior", async (t) => {
  for (const target of ["supervisor", "observe", "repair"]) {
    await t.step(target, async () => {
      const text = await Deno.readTextFile(
        new URL(`../../.github/workflows/${target}.yml`, import.meta.url),
      );
      assert.ok(
        text.includes(
          `run-name: \${{ inputs.sentinel_dispatch_request && format('sentinel-${target} request {0}', inputs.sentinel_dispatch_request) || '' }}`,
        ),
      );
      assert.ok(
        text.includes(
          '  workflow_dispatch:\n    inputs:\n      sentinel_dispatch_request:\n        description: Internal operator dispatch identity\n        required: false\n        type: string\n        default: ""',
        ),
      );
      assert.equal(text.match(/sentinel_dispatch_request/g)?.length, 3);
      assert.doesNotMatch(
        text.slice(text.indexOf("\npermissions:")),
        /sentinel_dispatch_request/,
      );
      assert.ok(!text.includes("\n  schedule:"));
      if (target === "supervisor") {
        assert.ok(
          text.includes("permissions:\n  contents: read\n  actions: read"),
        );
        assert.ok(
          text.includes(
            "group: sentinel-supervisor\n  cancel-in-progress: false",
          ),
        );
        assert.match(text, /timeout-minutes: 300/);
      } else if (target === "observe") {
        assert.ok(text.includes("permissions:\n  contents: read"));
        assert.match(
          text,
          /SENTINEL_GATEWAY_AUTH_JSON: \$\{\{ secrets\.SENTINEL_GATEWAY_AUTH_JSON \}\}/,
        );
      } else {
        assert.ok(text.includes("permissions:\n  actions: write"));
        assert.match(text, /-f ref=sentinel-supervisor/);
      }
    });
  }
});
