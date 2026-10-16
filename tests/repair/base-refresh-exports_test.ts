/**
 * The base-refresh module keeps every name it exported in the installed
 * generation-76 runtime (41bb853a1) and at the live launcher's merge base
 * (34e3b885d). Generation 77 moved the failure accounting into
 * loop-base-refresh-failure.ts; the live launcher's refresh re-arm
 * (ops/hosted-autonomy-refresh-rearm.ts) still imports
 * BASE_REFRESH_PRESERVE_DETAIL from loop-base-refresh.ts, and the merged
 * maintenance entry cannot even load when that export is missing. The values
 * are the moved ones, so a stored blocker message matches either import.
 */
import assert from "node:assert/strict";

import * as failure from "../../src/repair/loop-base-refresh-failure.ts";
import * as refresh from "../../src/repair/loop-base-refresh.ts";
import { BASE_REFRESH_PRESERVE_DETAIL } from "../../src/repair/loop-base-refresh.ts";

/** Exported by loop-base-refresh.ts at 41bb853a1 and 34e3b885d, then moved. */
const MOVED = [
  "MAX_BASE_REFRESH_FAILURES",
  "BASE_REFRESH_CAPABILITY_DETAIL",
  "BASE_REFRESH_PR_OBSERVATION_DETAIL",
  "BASE_REFRESH_UNPREPARED_DETAIL",
  "BASE_REFRESH_BASE_READ_DETAIL",
  "BASE_REFRESH_PRESERVE_DETAIL",
  "BASE_REFRESH_REF_READ_DETAIL",
  "BASE_REFRESH_PUSH_DETAIL",
  "BASE_REFRESH_FOREIGN_HEAD_DETAIL",
  "failBaseRefresh",
] as const;

/** Exported by loop-base-refresh.ts at 41bb853a1 and 34e3b885d, still owned. */
const OWNED = [
  "baseRefreshIntentKey",
  "ensureBaseRefreshIntent",
  "executeBaseRefreshIntent",
] as const;

Deno.test("the launcher's refresh re-arm import resolves to the moved preserve detail", () => {
  assert.equal(
    BASE_REFRESH_PRESERVE_DETAIL,
    "candidate could not be preserved",
  );
  assert.equal(
    BASE_REFRESH_PRESERVE_DETAIL,
    failure.BASE_REFRESH_PRESERVE_DETAIL,
  );
});

Deno.test("every generation-76 export of the base-refresh module is still exported", () => {
  const surface = refresh as Record<string, unknown>;
  const moved = failure as Record<string, unknown>;
  for (const name of MOVED) {
    assert.notEqual(surface[name], undefined, name);
    assert.equal(surface[name], moved[name], name);
  }
  for (const name of OWNED) {
    assert.equal(typeof surface[name], "function", name);
  }
});
