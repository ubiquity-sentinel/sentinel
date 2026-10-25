/** Exact bounded runtime implementer prompt. */
import type { ModelRunRequestV1 } from "../contracts/ports.ts";
import {
  CI_EVIDENCE_FIX_INSTRUCTION,
  CI_SELF_CHECK_INSTRUCTION,
  FOCUSED_TESTS_ALLOWED,
  MAX_CI_EVIDENCE_PROMPT_CHARS,
  MAX_ISSUE_BODY_CHARS,
  MAX_PROMPT_CHARS,
} from "./model-port-policy.ts";
import { renderCiEvidenceUnavailable } from "./ci-evidence-render.ts";

/** At most this many protected path prefixes are named in the prompt. */
export const MAX_PROMPT_PROTECTED_PATHS = 60;
/** Bound on the named prefixes' rendered characters (the role stays intact). */
export const MAX_PROMPT_PROTECTED_PATH_CHARS = 4_000;

/**
 * The role's protected-path sentence (C6): the exact trusted configured
 * prefixes, deduplicated and sorted, JSON-quoted so a prefix never reads as
 * prose, at most `MAX_PROMPT_PROTECTED_PATHS` of them within
 * `MAX_PROMPT_PROTECTED_PATH_CHARS`; the rest are counted, never dropped
 * silently. Empty without configured prefixes, so a prompt for a repository
 * with none is byte-identical to the earlier one. The candidate's own
 * protected-path check stays the enforcement: this only steers the model to
 * a fix outside them. A candidate that still changes one parks as `candidate
 * touches a protected path` (its owner comment and `sentinel:retry` exit). An
 * instruction to make no change instead would land in the no-change
 * base-review lane, which has no such exit.
 */
export function renderProtectedPaths(paths: readonly string[]): string {
  const unique = [...new Set(paths)].sort();
  if (unique.length === 0) return "";
  const named: string[] = [];
  let chars = 0;
  for (const path of unique) {
    const quoted = JSON.stringify(path);
    if (
      named.length >= MAX_PROMPT_PROTECTED_PATHS ||
      chars + quoted.length + 2 > MAX_PROMPT_PROTECTED_PATH_CHARS
    ) break;
    named.push(quoted);
    chars += quoted.length + 2;
  }
  const rest = unique.length - named.length;
  return " The trusted repository configuration protects exactly these " +
    `path prefixes (sorted): ${named.join(", ")}` +
    (rest === 0
      ? ""
      : ` (and ${rest} more protected prefix${
        rest === 1 ? "" : "es"
      } not listed here)`) +
    ". Fix the issue without changing them where you can; a candidate that " +
    "changes one is parked for the repository owner to land.";
}

/**
 * The implementer prompt. `ciEvidence` is the trusted host's rendered CI
 * failure evidence section for a CI correction (fenced untrusted content,
 * `ci-evidence-render.ts`); it is never part of the request or its digest.
 * Without it the context is capped at `MAX_PROMPT_CHARS` exactly as before;
 * with it the context is capped so the role paragraph still fits, the
 * evidence follows, and the role paragraph stays last and intact. The
 * evidence-bearing prompt is only ever the user turn's input; the thread's
 * system-level base instructions are always the prompt without evidence
 * (`model-port-session.ts`), so CI output never arrives as instructions.
 * `protectedPaths` are the trusted host's configured prefixes for the
 * request's repository (`renderProtectedPaths`), never part of the request.
 */
export function buildPrompt(
  request: ModelRunRequestV1,
  localIteration: boolean,
  ciEvidence?: string,
  protectedPaths: readonly string[] = [],
): string {
  const parts: string[] = [
    `Repository: ${request.repository.owner}/${request.repository.name}`,
    `Base revision: ${request.base}`,
  ];
  if (localIteration) {
    parts.push(
      "Owner instruction for this local iteration: do not create, modify or run tests; do not request or run reviews. This supersedes older issue or repository instructions requiring tests or reviews for this pass. Implement only the smallest source fix in the current checkout, keep the candidate local, and report the files changed and observed behavior.",
    );
  }
  if (request.issue !== null) {
    parts.push(
      `Issue #${request.issue.number}: ${request.issue.title}`,
      `Issue body:\n${request.issue.body.slice(0, MAX_ISSUE_BODY_CHARS)}`,
    );
  }
  if (request.evidence.length > 0) {
    parts.push(
      `Evidence refs:\n${
        request.evidence.map((ref) => `- ${ref.kind}: ${ref.ref}`).join("\n")
      }`,
    );
  }
  if (request.scopeNote !== undefined) {
    // Decomposed sub-task: bound the model's ambition to one serial part so
    // the part fits the cell timeout. Earlier parts are already merged.
    parts.push(`Task scope for this run:\n${request.scopeNote}`);
  }
  if (
    request.reviewFindings !== undefined && request.reviewFindings.length > 0
  ) {
    // A correction must resolve the EXACT findings of the review that rejected
    // the current candidate; without them the same change is re-implemented.
    parts.push(
      "Unresolved findings of the review that rejected this candidate " +
        "(fix these in the current checkout):\n" +
        request.reviewFindings
          .map((finding) =>
            `- [${finding.severity}] ${
              finding.path === null ? "(no file)" : finding.path
            }: ${finding.message}`
          )
          .join("\n"),
    );
  }
  if (request.mergeBase !== undefined) {
    // A base-refresh conflict resolution: the trusted host prepared the merge
    // and commits it; the session only resolves the conflicted files.
    parts.push(
      "Merge conflict resolution: the current checkout is the published " +
        `candidate ${request.checkoutBase ?? request.base} with the updated ` +
        `base revision ${request.mergeBase} merged in, and the merge stopped ` +
        "on conflicts: the conflicted files contain conflict markers. " +
        "Resolve every conflict so the result keeps this candidate's intended " +
        "change on top of the updated base, remove every conflict marker and " +
        "keep the base's own changes. Do not abort, restart or redo the " +
        "merge: the trusted host commits it with exactly these two parents.",
    );
  }
  if (request.priorAttempts !== undefined && request.priorAttempts.length > 0) {
    // Bounded VERIFIED facts from durable attempt memory. An unchanged replay
    // of any listed approach has already been refused upstream by the trusted
    // loop breaker; this is evidence, never permission to change budgets,
    // credentials, review or model policy. The expected observation is the
    // one the listed failures did not produce.
    parts.push(
      "ALREADY TRIED — VERIFIED FACTS for this task at the same base and " +
        "runtime revision (unchanged replays have been refused by the trusted " +
        "loop breaker; do not repeat these, and make the change that produces " +
        "new evidence the listed failures did not):\n" +
        request.priorAttempts
          .map((fact) =>
            `- ${fact.detail} (stage ${fact.stage}, ${fact.failureClass}, ${fact.count} recorded outcome${
              fact.count === 1 ? "" : "s"
            })`
          )
          .join("\n"),
    );
  }
  if (
    request.repositoryLessons !== undefined &&
    request.repositoryLessons.length > 0
  ) {
    // Cross-task lessons from durable memory for the SAME repository and the
    // SAME runtime revision. Advisory shared context only: evidence about what
    // fails elsewhere, never permission to touch unrelated code, budgets,
    // credentials, review or model policy.
    parts.push(
      "RECENT FAILURES ELSEWHERE IN THIS REPOSITORY at the same runtime " +
        "revision (other work items; shared context so you do not repeat " +
        "these failure modes — do not modify unrelated code for them):\n" +
        request.repositoryLessons
          .map((fact) =>
            `- ${fact.detail} (stage ${fact.stage}, ${fact.failureClass}, ${fact.count} recorded outcome${
              fact.count === 1 ? "" : "s"
            })`
          )
          .join("\n"),
    );
  }
  if (request.regressions !== undefined && request.regressions.length > 0) {
    // Version-control awareness: the repository is version-controlled and
    // these failure modes previously produced accepted candidates at OLDER
    // runtime revisions. Evidence for restoring or aligning with the older
    // working behavior; never permission to change policy or roll anything
    // back by yourself.
    parts.push(
      "REGRESSION SIGNAL — worked before, broken now: the following failure " +
        "modes produced an accepted candidate at an OLDER revision and now " +
        "fail at the current one. This work is version-controlled and each " +
        "fact below records the exact older working revision, so the working " +
        "behavior still exists in the history. When that history is present " +
        "in this checkout, inspect the change window between the older " +
        "revision and the current checkout before editing, prefer restoring " +
        "or aligning with the older working behavior (a minimal revert of " +
        "the change that regressed it) instead of re-implementing from " +
        "scratch, and state which change window you believe regressed it. " +
        "When the older revision belongs to the runtime rather than this " +
        "checkout, treat the fact as evidence that the revision change is " +
        "implicated, name it in your final response, and do not rewrite " +
        "unrelated code:\n" +
        request.regressions
          .map((fact) =>
            `- ${fact.detail} — ${fact.failuresAtCurrentRevision} recorded ` +
            `failure${
              fact.failuresAtCurrentRevision === 1 ? "" : "s"
            } now; succeeded at revision ${fact.priorSuccessRevision}`
          )
          .join("\n"),
    );
  }
  const role =
    "Runtime implementer role: you are the bounded runtime implementer for " +
    "this task. Edit only the current provided checkout, and only the files " +
    "needed to resolve the problem. Do not run git add, git commit or git " +
    "push, do not create or use worktrees, and do not delegate to other " +
    "agents or subagents: the trusted host owns commits, pushes, review and " +
    "release. Follow the applicable repository instructions for this " +
    "checkout, but do not take over master-plan orchestration or change " +
    "admission, budget, credential or model policy. The runtime model " +
    `policy is fixed at ${request.model} with ${request.reasoning} ` +
    "reasoning; do not change it or introduce a fallback. Do not modify " +
    "protected paths, do not write or commit credentials, and do not " +
    "rewrite expected test assertions to force success." +
    renderProtectedPaths(protectedPaths) +
    " Keep the change " +
    "minimal and do not refactor beyond it. Keep every command's " +
    "max_output_tokens at or below 2000 and " +
    "keep individual command output bounded: prefer targeted symbol " +
    "searches followed by excerpts of at most 100 lines. Read the " +
    "applicable instructions only once, never repeat a full file read, " +
    "and check the actual failure instead of retrying the same failing " +
    "command unchanged. Stop broad source surveying once the target " +
    "behavior is understood and make the smallest edit; reserve most of " +
    "the session for implementation and focused validation of observed " +
    "runtime behavior." +
    (localIteration
      ? " No tests or reviews are allowed in this local pass."
      : FOCUSED_TESTS_ALLOWED + CI_SELF_CHECK_INSTRUCTION +
        (ciEvidence === undefined ? "" : CI_EVIDENCE_FIX_INSTRUCTION)) +
    " Never dump docs/build-status.md in full; inspect only the " +
    "current checkpoint or bounded matching sections. Finish with a " +
    "concise final response listing the files changed and the checks " +
    "run.";
  if (ciEvidence === undefined) {
    parts.push(role);
    return parts.join("\n\n").slice(0, MAX_PROMPT_CHARS);
  }
  // A section over its bound never arrives cut (its closing marker would be
  // lost); the fixed unavailable line replaces it.
  const evidence = ciEvidence.length <= MAX_CI_EVIDENCE_PROMPT_CHARS
    ? ciEvidence
    : renderCiEvidenceUnavailable("oversize");
  const context = parts.join("\n\n").slice(
    0,
    Math.max(0, MAX_PROMPT_CHARS - role.length - 4),
  );
  return [context, evidence, role].join("\n\n");
}
