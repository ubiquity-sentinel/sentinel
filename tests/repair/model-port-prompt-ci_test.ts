/**
 * Implementer prompt with CI failure evidence (generation 81): the evidence
 * section rides outside the request, the role paragraph stays last and
 * intact, and the CI self-check instruction reaches every hosted run.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import { buildPrompt } from "../../src/repair/model-port-prompt.ts";
import {
  CI_EVIDENCE_FIX_INSTRUCTION,
  CI_SELF_CHECK_INSTRUCTION,
  MAX_CI_EVIDENCE_PROMPT_CHARS,
  MAX_PROMPT_CHARS,
} from "../../src/repair/model-port-policy.ts";
import {
  CI_EVIDENCE_FENCE_LABEL,
  renderCiEvidence,
} from "../../src/repair/ci-evidence-render.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { REPO, SHA1, SHA3 } from "../state/helpers.ts";
import { CHECKOUT, FakeCodexSession } from "./model-port-helpers.ts";

const REQUEST = {
  taskId: "issue-645" as never,
  repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
  base: "aafb7ee0598699bb7fb8a72ea133693ed64462da" as never,
  checkoutBase: "4a21c96d46e6f98c3c04125cafce34e255e710e3" as never,
  issue: { number: 645, title: "Bound lithos rate limits", body: "Body text." },
  evidence: [{ kind: "review_receipt", ref: "artifact:x" }],
  reviewFindings: [{
    severity: "P1",
    path: null,
    message:
      "Required CI checks failed on this candidate while the same checks passed on its base aafb7ee05986: validate (failure). Reproduce them.",
  }],
  model: "gpt-reserve",
  reasoning: "max",
  maxDurationMs: 5000,
  maxOutputChars: 12345,
} as ModelRunRequestV1;

/** SHA-256 of the generation-80 prompts for REQUEST (local, hosted). */
const GOLDEN_LOCAL =
  "9c37a1859035ae36e9dced6b42cd118f11e7b495f4b77846f95ed29a33d54454";
const GOLDEN_HOSTED_WITHOUT_SELF_CHECK =
  "391d10b14ad146ffa99b709f3b865e42bc3c3a54dfb171c3c6d0b032927db6ac";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

const NONCE = "00112233445566778899aabbccddeeff";

const EVIDENCE = renderCiEvidence({
  head: SHA3,
  base: SHA1,
  omittedChecks: 0,
  unavailable: null,
  checks: [{
    name: "validate",
    conclusion: "failure",
    app: "github-actions",
    workflow: null,
    job: null,
    failingSteps: [],
    classification: "candidate",
    classificationReason: "a repository command failed in a run step",
    annotations: [],
    excerpt: "[warn] src/provider/lithos-rate-limits.ts",
    excerptLines: null,
    hints: [],
    output: null,
    unavailable: null,
    truncatedScan: false,
  }],
}, NONCE);

Deno.test("without evidence the local prompt is byte-identical and the hosted one only adds the self-check", async () => {
  assert.equal(await sha256(buildPrompt(REQUEST, true)), GOLDEN_LOCAL);
  const hosted = buildPrompt(REQUEST, false);
  assert.ok(hosted.includes(CI_SELF_CHECK_INSTRUCTION));
  assert.ok(!hosted.includes(CI_EVIDENCE_FIX_INSTRUCTION));
  assert.equal(
    await sha256(hosted.replace(CI_SELF_CHECK_INSTRUCTION, "")),
    GOLDEN_HOSTED_WITHOUT_SELF_CHECK,
  );
  assert.ok(!buildPrompt(REQUEST, true).includes(CI_SELF_CHECK_INSTRUCTION));
});

Deno.test("the self-check tells the implementer to read CI and run the fast offline checks", () => {
  assert.match(CI_SELF_CHECK_INSTRUCTION, /CI workflow/);
  assert.match(CI_SELF_CHECK_INSTRUCTION, /format, lint, typecheck/);
  assert.match(CI_SELF_CHECK_INSTRUCTION, /offline/);
  assert.match(CI_EVIDENCE_FIX_INSTRUCTION, /root cause/);
  assert.match(CI_EVIDENCE_FIX_INSTRUCTION, /re-run/);
});

Deno.test("with evidence the role paragraph stays last and intact even when context overflows", () => {
  const plain = buildPrompt(REQUEST, false);
  const role = plain.slice(plain.indexOf("Runtime implementer role:"));
  const crowded: ModelRunRequestV1 = {
    ...REQUEST,
    issue: { number: 645, title: "t", body: "b".repeat(8_000) },
    reviewFindings: Array.from({ length: 8 }, () => ({
      severity: "P1",
      path: null,
      message: "m".repeat(2_000),
    })),
    scopeNote: "s".repeat(9_000),
  };
  const prompt = buildPrompt(crowded, false, EVIDENCE);
  assert.ok(prompt.includes(EVIDENCE), "the evidence is whole");
  assert.ok(
    prompt.endsWith(
      role.replace(
        CI_SELF_CHECK_INSTRUCTION,
        CI_SELF_CHECK_INSTRUCTION + CI_EVIDENCE_FIX_INSTRUCTION,
      ),
    ),
  );
  assert.ok(
    prompt.indexOf(EVIDENCE) < prompt.indexOf("Runtime implementer role:"),
  );
  assert.ok(prompt.length <= MAX_PROMPT_CHARS + MAX_CI_EVIDENCE_PROMPT_CHARS);
  const oversized = buildPrompt(crowded, false, "x".repeat(90_000));
  assert.ok(
    oversized.length <= MAX_PROMPT_CHARS + MAX_CI_EVIDENCE_PROMPT_CHARS,
  );
  assert.ok(oversized.endsWith("checks run."));
});

Deno.test("the local iteration never gets the CI instructions, even with evidence", () => {
  const prompt = buildPrompt(REQUEST, true, EVIDENCE);
  assert.ok(!prompt.includes(CI_SELF_CHECK_INSTRUCTION));
  assert.ok(!prompt.includes(CI_EVIDENCE_FIX_INSTRUCTION));
});

function portWith(session: FakeCodexSession): CodexImplementationPort {
  return new CodexImplementationPort({
    openSession: () => Promise.resolve(session),
    checkoutDir: CHECKOUT,
    checkout: {
      resolve: () =>
        Promise.resolve({
          head: SHA3,
          checkpointSha: null,
          changedPaths: ["src/provider/lithos-rate-limits.ts"],
        }),
    },
    modelProvider: "sentinel-host",
  });
}

const PORT_REQUEST: ModelRunRequestV1 = {
  ...REQUEST,
  taskId: asWorkItemId("issue-645"),
  repository: { ...REPO },
};

function frameParams(
  session: FakeCodexSession,
  method: string,
): Record<string, unknown> {
  const frame = session.sent.find((sent) => sent.method === method);
  assert.ok(frame !== undefined, method);
  return frame.params as Record<string, unknown>;
}

function turnText(session: FakeCodexSession): string {
  const input = frameParams(session, "turn/start").input as {
    type: string;
    text: string;
  }[];
  return input.map((item) => item.text).join("\n");
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

Deno.test("the model port puts the untrusted evidence only in the turn input, never in the thread instructions", async () => {
  const session = new FakeCodexSession();
  const result = await portWith(session).runModel(PORT_REQUEST, {
    untrustedCiEvidence: EVIDENCE,
  });
  assert.ok(result.ok, JSON.stringify(result));
  const thread = frameParams(session, "thread/start");
  // The system-level instruction slots hold only the trusted prompt: no
  // fence, no nonce and no line of CI output, and no fix instruction that
  // would point at evidence the instructions do not carry.
  assert.equal(thread.baseInstructions, buildPrompt(PORT_REQUEST, false));
  const instructions = [thread.baseInstructions, thread.developerInstructions]
    .filter((value) => typeof value === "string").join("\n");
  for (
    const untrusted of [
      CI_EVIDENCE_FENCE_LABEL,
      NONCE,
      "[warn] src/provider/lithos-rate-limits.ts",
      CI_EVIDENCE_FIX_INSTRUCTION,
    ]
  ) {
    assert.ok(!instructions.includes(untrusted), untrusted);
  }
  // The user turn carries the evidence-bearing prompt, the evidence once.
  const turn = turnText(session);
  assert.equal(turn, buildPrompt(PORT_REQUEST, false, EVIDENCE));
  assert.equal(occurrences(turn, EVIDENCE), 1);
  assert.equal(
    occurrences(turn, `<<<${CI_EVIDENCE_FENCE_LABEL} ${NONCE}>>>`),
    1,
  );
  assert.ok(turn.includes("[warn] src/provider/lithos-rate-limits.ts"));
  // The whole session sends the evidence exactly once.
  assert.equal(occurrences(JSON.stringify(session.sent), NONCE), 2);
});

Deno.test("without evidence the thread instructions and the turn input stay the same trusted prompt", async () => {
  const session = new FakeCodexSession();
  const result = await portWith(session).runModel(PORT_REQUEST);
  assert.ok(result.ok, JSON.stringify(result));
  const prompt = buildPrompt(PORT_REQUEST, false);
  assert.equal(frameParams(session, "thread/start").baseInstructions, prompt);
  assert.equal(turnText(session), prompt);
  assert.ok(!JSON.stringify(session.sent).includes(CI_EVIDENCE_FENCE_LABEL));
});
