import assert from "node:assert/strict";
import { releaseStateToken } from "../../src/host/actions-supervisor-host.ts";
import { STATIC_TOKEN } from "../../src/host/actions-supervisor-bootstrap.ts";

const TARGET_TOKEN = "target-installation-token-0123456789";
const SELF_TOKEN = "self-installation-token-0123456789";

Deno.test("hosted supervisor: release state uses the self installation token", () => {
  assert.equal(
    releaseStateToken({
      SENTINEL_SUPERVISOR_TOKEN: TARGET_TOKEN,
      SENTINEL_SELF_TOKEN: SELF_TOKEN,
    }),
    SELF_TOKEN,
  );
});

Deno.test("hosted supervisor: release state refuses an absent or malformed self token", () => {
  for (
    const env of [
      { SENTINEL_SUPERVISOR_TOKEN: TARGET_TOKEN },
      {
        SENTINEL_SUPERVISOR_TOKEN: TARGET_TOKEN,
        SENTINEL_SELF_TOKEN: "too-short",
      },
      {
        SENTINEL_SUPERVISOR_TOKEN: TARGET_TOKEN,
        SENTINEL_SELF_TOKEN: "",
      },
    ]
  ) {
    assert.throws(() => releaseStateToken(env), { message: STATIC_TOKEN });
  }
});

Deno.test("hosted supervisor: main forwards the self token before release-state selection", async () => {
  const source = await Deno.readTextFile(
    new URL("../../src/host/actions-supervisor-host.ts", import.meta.url),
  );
  assert.match(
    source,
    /\[SELF_TOKEN_ENV\]: Deno\.env\.get\(SELF_TOKEN_ENV\)/,
  );
});
