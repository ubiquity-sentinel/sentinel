/**
 * C6 prevention (redesign 2026-10-25): the implementer prompt names the exact
 * trusted protected path prefixes (sorted, at most 60) and tells the model to
 * fix the issue without them where it can, since a candidate that changes one
 * is parked for the owner (the existing protected-path park and its
 * `sentinel:retry` exit; a "make no change" instruction would land in the
 * no-change base-review lane instead). Without configured prefixes the prompt
 * is byte-identical to before.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import {
  buildPrompt,
  MAX_PROMPT_PROTECTED_PATHS,
  PUBLICATION_BOUNDS_SENTENCE,
  renderProtectedPaths,
} from "../../src/repair/model-port-prompt.ts";
import { MAX_PROMPT_CHARS } from "../../src/repair/model-port-policy.ts";
import {
  MAX_CHANGED_PATHS,
  MAX_FILE_BYTES,
  MAX_PROMPT_BYTES,
} from "../../src/github/snapshot-policy.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { protectedPathsFor } from "../../src/host/local-model.ts";
import { REPO, SHA1, SHA3 } from "../state/helpers.ts";
import { CHECKOUT, FakeCodexSession } from "./model-port-helpers.ts";

const REQUEST: ModelRunRequestV1 = {
  taskId: asWorkItemId("issue-262"),
  repository: { ...REPO },
  base: SHA1,
  issue: { number: 262, title: "Fix the model list", body: "Body text." },
  evidence: [],
  model: "gpt-reserve",
  reasoning: "max",
  maxDurationMs: 5_000,
  maxOutputChars: 12_345,
};

/** Unsorted, duplicated, as a merged template plus target policy can be. */
const PATHS = [
  "ops/",
  ".github/workflows/",
  "deno.json",
  "AGENTS.md",
  "ops/",
];

const SENTENCE =
  ' The trusted repository configuration protects exactly these path prefixes (sorted): ".github/workflows/", "AGENTS.md", "deno.json", "ops/". Fix the issue without changing them when a correct fix outside them exists. When the issue\'s fix genuinely requires changing a protected path, this narrows the rule above: make the real, complete change in place in that file, because a candidate that changes a protected path is parked for the repository owner to land as is, which is the useful outcome. Never substitute tests only, an unapplied .patch or .diff file, a copy of the file elsewhere, or a no-op for that change: such a candidate leaves the real file unchanged and can never be accepted.';

/**
 * SHA-256 of `buildPrompt(REQUEST, false, undefined, PATHS)` (pinned
 * 2026-10-25; re-pinned 2026-11-05 for the in-place protected-fix guidance).
 */
const GOLDEN_HOSTED_PROTECTED =
  "5658b4f877bc9f10f2f8dde79e728a52946a102240e6d0ee35fa246c02c002bf";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

Deno.test("the protected sentence names the exact prefixes sorted and deduplicated, with no no-change instruction", () => {
  assert.equal(renderProtectedPaths(PATHS), SENTENCE);
  assert.ok(!SENTENCE.includes("make no change"));
  assert.ok(!SENTENCE.includes("OWNER_LANDING_REQUIRED"));
  // ai.ubq.fi 1281/1282, 1210/1211: a required protected fix is made in
  // place, never replaced by tests, a patch file, a copy or a no-op.
  assert.ok(SENTENCE.includes("make the real, complete change in place"));
  assert.ok(SENTENCE.includes("an unapplied .patch or .diff file"));
  assert.ok(SENTENCE.includes("tests only"));
  assert.ok(SENTENCE.includes("a copy of the file elsewhere"));
  assert.ok(SENTENCE.includes("when a correct fix outside them exists"));
  assert.equal(renderProtectedPaths([]), "");
});

Deno.test("at most 60 prefixes are named and the rest are counted", () => {
  const many = Array.from(
    { length: 75 },
    (_, index) => `dir-${String(index).padStart(2, "0")}/`,
  );
  const sentence = renderProtectedPaths([...many].reverse());
  assert.equal(MAX_PROMPT_PROTECTED_PATHS, 60);
  assert.ok(sentence.includes('"dir-00/", "dir-01/"'));
  assert.ok(sentence.includes('"dir-59/"'));
  assert.ok(!sentence.includes('"dir-60/"'));
  assert.ok(
    sentence.includes("(and 15 more protected prefixes not listed here)."),
  );
  assert.equal(sentence.match(/"dir-\d\d\/"/g)?.length, 60);
  // Long prefixes stay within the character bound: 13 of 40 (306 rendered
  // characters each) fit in 4,000, and the other 27 are counted.
  const long = Array.from(
    { length: 40 },
    (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(300)}`,
  );
  const bounded = renderProtectedPaths(long);
  // The named prefixes stay within 4,000; the fixed guidance prose (about
  // 900 characters since 2026-11-05) is the rest.
  assert.ok(bounded.length < 5_000, String(bounded.length));
  assert.equal(bounded.match(/"\d\dx+"/g)?.length, 13);
  assert.match(bounded, /\(and 27 more protected prefixes not listed here\)/);
});

Deno.test("the prompt carries the sentence inside the role, and none without prefixes", async () => {
  const plain = buildPrompt(REQUEST, false);
  assert.equal(buildPrompt(REQUEST, false, undefined, []), plain);
  assert.ok(!plain.includes("protects exactly these"));
  const guarded = buildPrompt(REQUEST, false, undefined, PATHS);
  assert.equal(
    guarded,
    plain.replace(
      "to force success. Keep the change",
      `to force success.${SENTENCE} Keep the change`,
    ),
  );
  // The #333 publication-bounds sentence is the only later addition.
  assert.ok(guarded.includes(PUBLICATION_BOUNDS_SENTENCE));
  assert.equal(
    await sha256(guarded.replace(PUBLICATION_BOUNDS_SENTENCE, "")),
    GOLDEN_HOSTED_PROTECTED,
  );
  // With CI evidence the role (and so the sentence) stays last and intact.
  const crowded = {
    ...REQUEST,
    issue: { number: 262, title: "t", body: "y".repeat(40_000) },
    evidence: Array.from({ length: 400 }, (_, index) => ({
      kind: "review_receipt" as const,
      ref: `artifact:${index}`.padEnd(80, "z"),
    })),
  };
  const withEvidence = buildPrompt(crowded, false, "EVIDENCE", PATHS);
  assert.ok(withEvidence.includes(SENTENCE));
  assert.ok(withEvidence.endsWith("the checks run."));
  assert.ok(withEvidence.length <= MAX_PROMPT_CHARS + "EVIDENCE".length + 4);
});

Deno.test("the model port names the configured prefixes in the thread instructions and the turn", async () => {
  const session = new FakeCodexSession();
  const port = new CodexImplementationPort({
    openSession: () => Promise.resolve(session),
    checkoutDir: CHECKOUT,
    checkout: {
      resolve: () =>
        Promise.resolve({
          head: SHA3,
          checkpointSha: null,
          changedPaths: ["src/app.ts"],
        }),
    },
    modelProvider: "sentinel-host",
    protectedPaths: PATHS,
  });
  const result = await port.runModel(REQUEST);
  assert.ok(result.ok, JSON.stringify(result));
  const thread = session.sent.find((frame) => frame.method === "thread/start");
  const turn = session.sent.find((frame) => frame.method === "turn/start");
  const instructions = (thread?.params as Record<string, unknown>)
    .baseInstructions;
  assert.equal(instructions, buildPrompt(REQUEST, false, undefined, PATHS));
  assert.ok(String(instructions).includes(SENTENCE));
  const input = (turn?.params as { input: { text: string }[] }).input;
  assert.equal(input[0].text, instructions);
  // The request, its digest and the receipt carry no prefix list.
  assert.ok(!JSON.stringify(REQUEST).includes("AGENTS.md"));
});

Deno.test("the hosted port resolves the prefixes of exactly the requested repository", () => {
  const configs = [
    {
      repository: {
        owner: "ubiquity",
        name: "passport.ubq.fi",
        installationId: 7,
      },
      protectedPaths: ["wrangler.jsonc"],
    },
    { repository: { ...REPO }, protectedPaths: ["ops/"] },
  ];
  assert.deepEqual(protectedPathsFor(configs, REPO), ["ops/"]);
  assert.deepEqual(
    protectedPathsFor(configs, {
      owner: "ubiquity",
      name: "passport.ubq.fi",
      installationId: 7,
    }),
    ["wrangler.jsonc"],
  );
  assert.deepEqual(
    protectedPathsFor(configs, {
      owner: "ubiquity-sentinel",
      name: "sentinel",
      installationId: 7,
    }),
    [],
  );
  assert.deepEqual(protectedPathsFor(undefined, REPO), []);
});

Deno.test("#333: the prompt carries the trusted denylist and the exact publication bounds", () => {
  const prompt = buildPrompt(REQUEST, false, undefined, PATHS);
  assert.ok(prompt.includes(SENTENCE));
  assert.ok(prompt.includes(PUBLICATION_BOUNDS_SENTENCE));
  assert.ok(prompt.includes(`more than ${MAX_CHANGED_PATHS} paths`));
  assert.ok(prompt.includes(`larger than ${MAX_FILE_BYTES} bytes`));
  assert.ok(prompt.includes(`${MAX_PROMPT_BYTES} total new bytes`));
  // Nothing beyond the trusted constants: the session's own transport output
  // allowance is still not part of the prompt.
  assert.ok(!prompt.includes(String(REQUEST.maxOutputChars)));
});
