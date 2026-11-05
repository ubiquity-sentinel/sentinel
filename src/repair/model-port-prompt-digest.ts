/**
 * A stable digest of the implementer prompt TEMPLATE: its fixed prose with no
 * per-record input. The repeat-failure bound records it on a park
 * (` prompt=`), so a runtime whose implementer prompt changed re-arms a park
 * once, while an install that leaves the prompt as it was never does.
 *
 * The template is rendered by the real `buildPrompt` over one constant
 * placeholder request that turns on every optional section (issue, evidence,
 * scope, review findings, merge conflict, refused and prior attempts,
 * repository lessons, regressions, protected paths, CI evidence) and once
 * more as a local iteration, so a prose change in any section changes the
 * digest. Placeholders are constant: no repository, issue, base, model route
 * or protected-path list of a real record reaches it.
 */
import { createHash } from "node:crypto";
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type { ModelRunRequestV1 } from "../contracts/ports.ts";
import { IDENTICAL_ATTEMPT_FACT_PREFIX } from "../contracts/attempt-input.ts";
import { buildPrompt } from "./model-port-prompt.ts";

const SHA_A = "a".repeat(40) as GitSha;
const SHA_B = "b".repeat(40) as GitSha;

function fact(detail: string) {
  return {
    detail,
    stage: "model" as const,
    failureClass: "unknown" as const,
    count: 1,
    lastAtMs: 0,
  };
}

const PLACEHOLDER: ModelRunRequestV1 = {
  taskId: "prompt-template" as WorkItemId,
  repository: { owner: "owner", name: "repository", installationId: 1 },
  base: SHA_A,
  checkoutBase: SHA_A,
  mergeBase: SHA_B,
  issue: { number: 1, title: "title", body: "body" },
  evidence: [{ kind: "review_receipt", ref: "ref" }],
  reviewFindings: [{ severity: "P0", path: "path", message: "message" }],
  priorAttempts: [
    fact(`${IDENTICAL_ATTEMPT_FACT_PREFIX}detail`),
    fact("detail"),
  ],
  repositoryLessons: [fact("lesson")],
  regressions: [{
    detail: "regression",
    priorSuccessRevision: SHA_B,
    priorSuccessAtMs: 0,
    failuresAtCurrentRevision: 1,
    lastFailureAtMs: 0,
  }],
  model: "model",
  reasoning: "max",
  maxDurationMs: 1,
  maxOutputChars: 1,
  scopeNote: "scope",
};

let cached: string | null = null;

/** 64 hex of the implementer prompt template (see module doc). */
export function implementerPromptTemplateDigest(): string {
  if (cached !== null) return cached;
  const paths = ["protected/"];
  const renders = [
    buildPrompt(PLACEHOLDER, false, undefined, paths),
    buildPrompt(PLACEHOLDER, false, "CI EVIDENCE", paths),
    buildPrompt(PLACEHOLDER, true, undefined, paths),
  ];
  cached = createHash("sha256").update(
    JSON.stringify({
      domain: "sentinel.implementer-prompt-template.v1",
      renders,
    }),
    "utf8",
  ).digest("hex");
  return cached;
}
