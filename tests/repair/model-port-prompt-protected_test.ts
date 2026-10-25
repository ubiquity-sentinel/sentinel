/**
 * C6 prevention (redesign 2026-10-25): the implementer prompt names the exact
 * trusted protected path prefixes (sorted, at most 60) and tells the model to
 * make no change and say `OWNER_LANDING_REQUIRED: <paths>` when the fix needs
 * one. Without configured prefixes the prompt is byte-identical to before.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import {
  buildPrompt,
  MAX_PROMPT_PROTECTED_PATHS,
  OWNER_LANDING_REQUIRED,
  renderProtectedPaths,
} from "../../src/repair/model-port-prompt.ts";
import { MAX_PROMPT_CHARS } from "../../src/repair/model-port-policy.ts";
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
  ' The trusted repository configuration protects exactly these path prefixes (sorted): ".github/workflows/", "AGENTS.md", "deno.json", "ops/". If the fix requires one of these paths, make no change and say OWNER_LANDING_REQUIRED: <paths>.';

/** SHA-256 of `buildPrompt(REQUEST, false, undefined, PATHS)` (pinned 2026-10-25). */
const GOLDEN_HOSTED_PROTECTED =
  "e031f9d1de16d5d00bdbb65c1d4d9a47a91f47c734b74f374958070113b4bcfc";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

Deno.test("the protected sentence names the exact prefixes sorted and deduplicated with the owner-landing marker", () => {
  assert.equal(renderProtectedPaths(PATHS), SENTENCE);
  assert.equal(OWNER_LANDING_REQUIRED, "OWNER_LANDING_REQUIRED");
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
  assert.ok(bounded.length < 4_500, String(bounded.length));
  assert.equal(bounded.match(/"\d\dx+"/g)?.length, 13);
  assert.match(bounded, /\(and 27 more protected prefixes not listed here\)/);
});

Deno.test("the prompt carries the sentence inside the role, and none without prefixes", async () => {
  const plain = buildPrompt(REQUEST, false);
  assert.equal(buildPrompt(REQUEST, false, undefined, []), plain);
  assert.ok(!plain.includes(OWNER_LANDING_REQUIRED));
  const guarded = buildPrompt(REQUEST, false, undefined, PATHS);
  assert.equal(
    guarded,
    plain.replace(
      "to force success. Keep the change",
      `to force success.${SENTENCE} Keep the change`,
    ),
  );
  assert.equal(await sha256(guarded), GOLDEN_HOSTED_PROTECTED);
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
