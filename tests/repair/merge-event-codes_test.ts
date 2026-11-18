/**
 * The closed `sentinel_merge_event` detail codes: one fixed code per static
 * adapter detail, emitted by the runtime and accepted by the launcher. A code
 * is only useful while its detail is still the exact text its adapter returns.
 */
import assert from "node:assert/strict";
import { parseSentinelMergeEventV1 } from "../../src/host/hosted-runtime-diagnostics.ts";
import { MERGE_EVENT_DETAIL_CODES } from "../../src/host/hosted-runtime-identity.ts";
import {
  MERGE_DETAIL_CODES,
  mergeDetailCode,
} from "../../src/repair/merge-event-codes.ts";

/** Where every self merge `invalid` detail is returned. */
const SELF_MERGE_PRODUCERS = [
  "src/github/port-self-merge.ts",
  "src/github/port-merge.ts",
  "src/github/git-executor.ts",
  "src/github/client-native-ci.ts",
];

Deno.test("merge event codes: one fixed code per detail, never free text", () => {
  const details = MERGE_DETAIL_CODES.map(([detail]) => detail);
  const codes = MERGE_DETAIL_CODES.map(([, code]) => code);
  assert.equal(new Set(details).size, details.length);
  assert.equal(new Set(codes).size, codes.length);
  for (const [detail, code] of MERGE_DETAIL_CODES) {
    assert.match(code, /^[a-z][a-z_]{2,39}$/);
    assert.equal(mergeDetailCode(detail), code);
  }
  assert.equal(mergeDetailCode("self merge trusted CI pipeline"), null);
  assert.equal(mergeDetailCode("GitHub API request failed"), null);
});

Deno.test("merge event codes: every self merge code names a detail its adapter still returns", async () => {
  const sources = await Promise.all(
    SELF_MERGE_PRODUCERS.map((path) => Deno.readTextFile(path)),
  );
  const selfCodes = MERGE_DETAIL_CODES.filter(([, code]) =>
    code.startsWith("self_merge_")
  );
  assert.equal(selfCodes.length, 19);
  for (const [detail, code] of selfCodes) {
    assert.ok(
      sources.some((text) => text.includes(`"${detail}"`)),
      `${code}: "${detail}" is no longer returned verbatim`,
    );
  }
});

Deno.test("merge event codes: the launcher accepts exactly the codes the runtime emits", () => {
  assert.deepEqual(
    [...MERGE_EVENT_DETAIL_CODES],
    MERGE_DETAIL_CODES.map(([, code]) => code),
  );
  for (const [, code] of MERGE_DETAIL_CODES) {
    const line = {
      version: "v1",
      kind: "sentinel_merge_event",
      event: "merge_port_error",
      prNumber: 415,
      errorKind: "invalid",
      detailCode: code,
    };
    assert.deepEqual(parseSentinelMergeEventV1(line), line);
  }
  assert.equal(
    parseSentinelMergeEventV1({
      version: "v1",
      kind: "sentinel_merge_event",
      event: "merge_port_error",
      prNumber: 415,
      errorKind: "invalid",
      detailCode: "self merge trusted CI pipeline changed",
    }),
    null,
  );
});
