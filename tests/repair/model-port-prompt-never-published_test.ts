/**
 * The never-published sentence (2026-11-17): the implementer prompt names,
 * from the target's own configured prefixes, exactly those the publication
 * gate never publishes (`unpublishablePath`, the predicate
 * `ownerLandingTouch` parks with), and tells the model to solve the task
 * without them or leave them unchanged and say so. ai.ubq.fi 1370 attempt 2
 * spent a 767 s charged run on a candidate that changed
 * `.github/workflows/deno-deploy.yml` and parked unpublished. Prompts whose
 * prefixes include none are unchanged, and so is the template digest the
 * repeat-failure bound re-arms parks on.
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

/** The JSON-quoted prefixes the never-published sentence lists. */
function listed(sentence: string): string[] {
  const match = sentence.match(/never published \(sorted\): (.*?)\. A cand/);
  assert.ok(match !== null, sentence);
  return JSON.parse(`[${match[1]}]`);
}

/** The configured prefixes the gate itself refuses to publish. */
function gateRefused(
  config: ReturnType<typeof policyFor>,
): string[] {
  return [...new Set(config.protectedPaths)].filter((prefix) => {
    const probes = prefix.endsWith("/")
      ? [prefix, `${prefix}probe.txt`]
      : [prefix];
    const verdicts = probes.map((path) =>
      ownerLandingTouch(config, [path]).kind
    );
    // Every probe of a configured prefix is protected: owner or refused.
    assert.ok(verdicts.every((kind) => kind !== "none"), prefix);
    return verdicts.includes("unpublishable");
  }).sort();
}

Deno.test("the listed prefixes are exactly those the gate refuses for sentinel, ai.ubq.fi and a generic target", () => {
  const sentinel = policyFor("ubiquity-sentinel", "sentinel");
  const gateway = policyFor("ubiquity", "ai.ubq.fi");
  const generic = policyFor("acme", "app", GENERIC_FACTS);
  for (const config of [sentinel, gateway, generic]) {
    const sentence = renderNeverPublishedPaths(config.protectedPaths);
    assert.deepEqual(listed(sentence), gateRefused(config));
    assert.ok(!sentence.includes("not listed here"));
  }
  // Sentinel protects only its authority set: every prefix is refused.
  assert.deepEqual(
    listed(renderNeverPublishedPaths(sentinel.protectedPaths)),
    [...new Set(sentinel.protectedPaths)].sort(),
  );
  // ai.ubq.fi: the workflows and env are refused; its owner-landing
  // prefixes are published for the owner to merge and are not listed.
  const gatewayListed = listed(
    renderNeverPublishedPaths(gateway.protectedPaths),
  );
  for (const refused of [".github/workflows/", ".env"]) {
    assert.ok(gatewayListed.includes(refused), refused);
  }
  for (const owner of ["AGENTS.md", "docs/DECISIONS.md", "src/sentinel/"]) {
    assert.ok(gateway.protectedPaths.includes(owner), owner);
    assert.ok(!gatewayListed.includes(owner), owner);
  }
  // The 1370 candidate: one workflow among five paths parks it unpublished.
  assert.equal(
    ownerLandingTouch(gateway, [
      "src/app.ts",
      ".github/workflows/deno-deploy.yml",
    ]).kind,
    "unpublishable",
  );
  // Generic: the fixed boundary, an env file and an authority prefix are
  // refused; an ordinary `sentinel.protected` prefix is owner-landed.
  const genericListed = listed(
    renderNeverPublishedPaths(generic.protectedPaths),
  );
  for (const refused of [".github/workflows/", "config/.env.shared"]) {
    assert.ok(genericListed.includes(refused), refused);
  }
  // `sentinel.protected` entries arrive normalized (no trailing slash).
  assert.ok(genericListed.includes("src/host"));
  assert.ok(generic.protectedPaths.includes("docs"));
  assert.ok(!genericListed.includes("docs"));
});

Deno.test("the sentence follows the configured list in every prompt variant and names no untrusted text", () => {
  const gateway = policyFor("ubiquity", "ai.ubq.fi");
  const paths = gateway.protectedPaths;
  const both = renderProtectedPaths(paths) + renderNeverPublishedPaths(paths);
  const plain = buildPrompt(REQUEST, false);
  assert.equal(
    buildPrompt(REQUEST, false, undefined, paths),
    plain.replace(
      "to force success. Keep the change",
      `to force success.${both} Keep the change`,
    ),
  );
  for (
    const prompt of [
      buildPrompt(REQUEST, false, "EVIDENCE", paths),
      buildPrompt(REQUEST, true, undefined, paths),
      buildPrompt({ ...REQUEST, mergeBase: SHA1 }, false, undefined, paths),
    ]
  ) {
    assert.ok(prompt.includes(both));
    assert.ok(prompt.endsWith("the checks run."));
  }
  const sentence = renderNeverPublishedPaths(paths);
  assert.ok(sentence.startsWith(" Of those, a change under any of these"));
  assert.ok(sentence.includes("solve the task without changing them"));
  assert.ok(
    sentence.endsWith(
      "leave them all unchanged and say so in your final response.",
    ),
  );
  assert.ok(!sentence.includes(REQUEST.issue!.title));
});

Deno.test("a prompt with no never-published prefix is byte-identical, and the template digest is unchanged", () => {
  const plain = buildPrompt(REQUEST, false);
  assert.equal(renderNeverPublishedPaths([]), "");
  assert.equal(buildPrompt(REQUEST, false, undefined, []), plain);
  const owner = ["docs/", "AGENTS.md", "protected/"];
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

Deno.test("at most 60 never-published prefixes are named and the rest are counted", () => {
  const many = Array.from(
    { length: 75 },
    (_, index) => `.github/x-${String(index).padStart(2, "0")}/`,
  );
  const sentence = renderNeverPublishedPaths([...many, "docs/"].reverse());
  assert.equal(sentence.match(/"\.github\/x-\d\d\/"/g)?.length, 60);
  assert.ok(!sentence.includes('"docs/"'));
  assert.ok(
    sentence.includes(
      "(and 15 more never-published prefixes not listed here).",
    ),
  );
});
