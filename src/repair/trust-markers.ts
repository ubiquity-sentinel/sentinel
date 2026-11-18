/**
 * The App issue markers provenance trust reads (2026-11-17,
 * `workflow-trust.ts`): an App issue whose first two body lines are exactly
 * these is the target capability notice, whose text Sentinel writes from its
 * own facts. Kept apart from the notice's composition
 * (`target-capability.ts`, ordinary work) so only the owner can change what
 * trust recognises; a changed notice that no longer carries them is merely
 * untrusted (fail closed).
 */

/** The first body line every owner-action issue carries (intake skips it). */
export const SENTINEL_SKIP_MARKER = "<!-- sentinel:skip -->";

/** Second body line: identifies Sentinel's capability issue. */
export const TARGET_CAPABILITY_ISSUE_MARKER =
  "<!-- sentinel:target-capability -->";
