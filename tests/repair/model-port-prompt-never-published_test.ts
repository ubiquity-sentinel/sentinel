/**
 * The credential sentence (owner directive 2026-11-17, "give sentinel full
 * access"): the implementer prompt names, from the target's own configured
 * prefixes, exactly those the publication gate never publishes
 * (`unpublishablePath`, the predicate `ownerLandingTouch` parks with:
 * credential and history paths), and says that a change to any other listed
 * prefix is published as an ordinary pull request through the same gates,
 * never incidentally and in place when the task needs it. It never asks for
 * no change or a final-response report (2026-10-25 withdrawal). Prompts whose
 * prefixes include no credential prefix are unchanged, and so is the template
 * digest the repeat-failure bound re-arms parks on.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import {
  buildPrompt,
  renderNeverPublishedPaths,
  renderProtectedPaths,
} from "../../src/repair/model-port-prompt.ts";
import { implementerPromptTemplateDigest } from "../../src/repair/model-port-prompt-digest.ts";
import { ownerLandingTouch } from "../../src/repair/owner-landing.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { selectTrustedTargetPolicyV1 } from "../../src/host/target-policy.ts";
import type { TargetTreeFactsV1 } from "../../src/host/target-policy-generic.ts";
import { REPO, SHA1 } from "../state/helpers.ts";

const REQUEST: ModelRunRequestV1 = {
  taskId: asWorkItemId("issue-1370"),
  repository: { ...REPO },
  base: SHA1,
  issue: { number: 1370, title: "Repair the red base", body: "Body text." },
  evidence: [],
  model: "gpt-reserve",
  reasoning: "max",
  maxDurationMs: 5_000,
  maxOutputChars: 12_345,
};

/** The digest every park written before this change records (` prompt=`). */
const TEMPLATE_DIGEST =
  "29921b7659c5410ea0491fab5a15f5fb852b399b082b1d6c4344466dc786c6bc";

const GENERIC_FACTS: TargetTreeFactsV1 = {
  files: ["deno.json"],
  hasCiWorkflow: true,
  sentinelProtected: ["docs/", "config/.env.shared", "src/host/"],
};

function policyFor(owner: string, name: string, facts?: TargetTreeFactsV1) {
  const policy = selectTrustedTargetPolicyV1(
    createLocalRepositoryConfig(),
    { owner, name },
    facts,
  );
  return { commands: policy.commands, protectedPaths: policy.protectedPaths };
}

/** The JSON-quoted prefixes the credential sentence lists. */
function listed(sentence: string): string[] {
  const match = sentence.match(
    /never published \(sorted\): (.*?); never change or create/,
  );
  assert.ok(match !== null, sentence);
  return JSON.parse(`[${match[1]}]`);
}

/** The configured prefixes the gate itself refuses to publish. */
function gateRefused(
  config: ReturnType<typeof policyFor>,
  repository: { owner: string; name: string },
): string[] {
  return [...new Set(config.protectedPaths)].filter((prefix) => {
    const probes = prefix.endsWith("/")
      ? [prefix, `${prefix}probe.txt`]
      : [prefix];
    return probes.map((path) =>
      ownerLandingTouch(config, [path], repository).kind
    ).includes("unpublishable");
  }).sort();
}

Deno.test("the listed prefixes are exactly those the gate refuses for ai.ubq.fi and a generic target; Sentinel lists none", () => {
  const gatewayId = { owner: "ubiquity", name: "ai.ubq.fi" };
  const genericId = { owner: "acme", name: "app" };
  const gateway = policyFor(gatewayId.owner, gatewayId.name);
  const generic = policyFor(genericId.owner, genericId.name, GENERIC_FACTS);
  assert.deepEqual(
    listed(renderNeverPublishedPaths(gateway.protectedPaths)),
    gateRefused(gateway, gatewayId),
  );
  assert.deepEqual(
    listed(renderNeverPublishedPaths(generic.protectedPaths)),
    gateRefused(generic, genericId),
  );
  // ai.ubq.fi: only its env file is refused; the workflows publish.
  assert.deepEqual(
    listed(renderNeverPublishedPaths(gateway.protectedPaths)),
    [".env"],
  );
  // The 1370 candidate shape now publishes as an ordinary pull request.
  assert.equal(
    ownerLandingTouch(gateway, [
      "src/app.ts",
      ".github/workflows/deno-deploy.yml",
    ], gatewayId).kind,
    "none",
  );
  // Generic: the env family, `.git/`, the act/npm files and the list file.
  const genericListed = listed(
    renderNeverPublishedPaths(generic.protectedPaths),
  );
  for (
    const refused of [".env", ".git/", ".npmrc", "config/.env.shared"]
  ) assert.ok(genericListed.includes(refused), refused);
  for (const ordinary of [".github/workflows/", "docs", "src/host"]) {
    assert.ok(!genericListed.includes(ordinary), ordinary);
  }
  // Sentinel's own list holds no credential prefix: no sentence at all.
  const sentinel = policyFor("ubiquity-sentinel", "sentinel");
  assert.equal(renderNeverPublishedPaths(sentinel.protectedPaths), "");
});

/** The exact sentence for a list with one credential prefix. */
const ENV_SENTENCE =
  ' Of those, a change under any of these credential prefixes is never published (sorted): ".env"; never change or create a file under them. On this repository a change to any other listed prefix is not parked: it is published as an ordinary pull request and must pass the same CI and review gates as any other change, so never change one incidentally, prefer a solution that does not touch it, and when the task needs it make the minimal, complete change in place.';

Deno.test("the sentence keeps the in-place rule, says other prefixes publish, and asks for no no-change outcome", () => {
  const paths = [".github/workflows/", "AGENTS.md", ".env"];
  const sentence = renderNeverPublishedPaths(paths);
  assert.equal(sentence, ENV_SENTENCE);
  for (
    const banned of [
      "make no change",
      "no change",
      "final response",
      "say so",
      "leave them",
      "unchanged",
      "without changing them",
      "parked unpublished",
      "owner must make",
    ]
  ) assert.ok(!sentence.includes(banned), banned);
  const configured = renderProtectedPaths(paths);
  assert.ok(configured.includes("make the real, complete change in place"));
  assert.ok(sentence.includes("never change one incidentally"));
  // Every prompt variant carries both sentences after the configured list.
  const both = configured + sentence;
  for (
    const prompt of [
      buildPrompt(REQUEST, false, undefined, paths),
      buildPrompt(REQUEST, false, "EVIDENCE", paths),
      buildPrompt(REQUEST, true, undefined, paths),
    ]
  ) assert.ok(prompt.includes(both));
  assert.ok(!sentence.includes(REQUEST.issue!.title));
});

Deno.test("a prompt with no credential prefix is byte-identical, and the template digest is unchanged", () => {
  const plain = buildPrompt(REQUEST, false);
  assert.equal(renderNeverPublishedPaths([]), "");
  assert.equal(buildPrompt(REQUEST, false, undefined, []), plain);
  const owner = [".github/workflows/", "AGENTS.md", "protected/"];
  assert.equal(renderNeverPublishedPaths(owner), "");
  assert.equal(
    buildPrompt(REQUEST, false, undefined, owner),
    plain.replace(
      "to force success. Keep the change",
      `to force success.${renderProtectedPaths(owner)} Keep the change`,
    ),
  );
  // The repeat-failure bound re-arms a park once when this digest moves;
  // this change leaves it where every existing park recorded it.
  assert.equal(implementerPromptTemplateDigest(), TEMPLATE_DIGEST);
});

Deno.test("at most 60 credential prefixes are named and the rest are counted", () => {
  const many = Array.from(
    { length: 75 },
    (_, index) => `.env.x-${String(index).padStart(2, "0")}`,
  );
  const sentence = renderNeverPublishedPaths([...many, "docs/"].reverse());
  assert.equal(sentence.match(/"\.env\.x-\d\d"/g)?.length, 60);
  assert.ok(!sentence.includes('"docs/"'));
  assert.ok(
    sentence.includes(
      "(and 15 more never-published prefixes not listed here);",
    ),
  );
});
