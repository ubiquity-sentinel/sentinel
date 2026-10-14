// snapshot policy.

import { MaxItems } from "../contracts/validation.ts";

/** Whole snapshot operation bound: no read may outlive this. */
export const MAX_SNAPSHOT_TOTAL_MS = 30_000;

/** One finite changed-path bound; overflow is rejected, never truncated. */
export const MAX_CHANGED_PATHS = 128;

/** Complete trusted review prompt bound in UTF-8 bytes. */
export const MAX_PROMPT_BYTES = 1024 * 1024;

/** One candidate changed-file publication bound in UTF-8 bytes. */
export const MAX_FILE_BYTES = 512 * 1024;

/**
 * NEW separate manifest capture scan bound: one complete trusted blob read.
 * The manifest scan only validates a blob and derives its line metadata, so
 * it admits a larger exact blob than the candidate publication bound while
 * still refusing anything over this finite limit.
 */
export const MAX_CAPTURE_BLOB_BYTES = 1024 * 1024;

/** One repository-relative path bound in characters. */
export const MAX_PATH_CHARS = 1024;

/** Snapshot value version. */
export const SNAPSHOT_VERSION = "v1" as const;

/** One publication validation: newly exposed commit bound (overflow rejects). */
export const MAX_NEW_COMMITS = 128;

/** One publication validation: newly exposed object bound (overflow rejects). */
export const MAX_NEW_OBJECTS = 4096;

/** One newly exposed commit's parent-edge bound (an octopus merge stays finite). */
export const MAX_COMMIT_PARENTS = 64;

/** One publication validation: protected-path entries, the repository config bound. */
export const MAX_PROTECTED_PATHS = MaxItems.protectedPaths;

/** Combined bounded protected-path characters accepted from the config. */
export const MAX_PROTECTED_PATHSPEC_CHARS = 128 * 1024;

/** One newly exposed commit metadata read bound. */
export const MAX_METADATA_BYTES = MAX_FILE_BYTES;

/** One recursive root-tree listing bound for a newly exposed root commit. */
export const MAX_TREE_READ_BYTES = (MAX_NEW_OBJECTS + 1) *
  (MAX_PATH_CHARS + 64);

/** One exact `ls-tree -z` entry read bound for one literal protected path. */
export const MAX_TREE_ENTRY_BYTES = MAX_PATH_CHARS + 64;

export const ZERO_SHA = "0".repeat(40);

export const ZERO_MODE = "000000";

export const BLOB_PATTERN = /^[0-9a-f]{40}$/;

export const MODE_PATTERN = /^[0-9]{6}$/;

/** Raw/NUL-delimited changed-list read bound (path bound plus raw metadata). */
export const RAW_READ_BYTES = (MAX_CHANGED_PATHS + 1) * (MAX_PATH_CHARS + 160);

/** Small scalar reads (resolved ids, merge base). */
export const SCALAR_READ_BYTES = 4096;

export const SNAPSHOT_INPUT_DETAIL =
  "review snapshot unavailable: expected exact base and head commit SHAs";

export const SNAPSHOT_DEADLINE_DETAIL =
  "review snapshot unavailable: the bounded snapshot operation deadline elapsed";

export const SNAPSHOT_READ_DETAIL =
  "review snapshot unavailable: a trusted Git object read did not settle with exit 0";

export const SNAPSHOT_OVERBOUND_DETAIL =
  "review snapshot unavailable: a Git object read exceeded its finite output bound";

export const SNAPSHOT_UNSETTLED_DETAIL =
  "review snapshot unavailable: a Git object read did not prove process settlement";

export const SNAPSHOT_COMMIT_DETAIL =
  "review snapshot unavailable: base or head is not the exact commit object requested";

export const SNAPSHOT_STALE_BASE_DETAIL =
  "review snapshot unavailable: base is not an ancestor of head (stale base)";

export const SNAPSHOT_MERGE_BASE_DETAIL =
  "review snapshot unavailable: merge base does not equal the exact base";

export const SNAPSHOT_RAW_DETAIL =
  "review snapshot unavailable: the changed-path list is malformed";

export const SNAPSHOT_PATHS_DETAIL =
  "review snapshot unavailable: the changed-path bound was exceeded";

export const SNAPSHOT_EMPTY_DETAIL =
  "review snapshot unavailable: the change has no changed paths";

export const SNAPSHOT_PATH_DETAIL =
  "review snapshot unavailable: a changed path is unsafe or over bound";

export const SNAPSHOT_MODE_DETAIL =
  "review snapshot unavailable: a changed path has an unsupported Git mode";

export const SNAPSHOT_SYMLINK_DETAIL =
  "review snapshot unavailable: changed symlinks are unsupported";

export const SNAPSHOT_SUBMODULE_DETAIL =
  "review snapshot unavailable: changed submodules are unsupported";

export const SNAPSHOT_STATUS_DETAIL =
  "review snapshot unavailable: a changed path has an unsupported status";

export const SNAPSHOT_BINARY_DETAIL =
  "review snapshot unavailable: a changed blob is binary";

export const SNAPSHOT_UTF8_DETAIL =
  "review snapshot unavailable: a changed blob is not valid UTF-8 text";

export const SNAPSHOT_FILE_BOUND_DETAIL =
  "review snapshot unavailable: a changed blob exceeded its finite capture bound";

export const SNAPSHOT_PROMPT_BOUND_DETAIL =
  "review snapshot unavailable: the complete review prompt exceeded its finite bound";

export const SNAPSHOT_SHAPE_DETAIL =
  "review snapshot unavailable: the supplied snapshot value is malformed";

/** Static sanitized digest-binding failure shared with the review producer. */
export const SNAPSHOT_DIGEST_DETAIL =
  "review snapshot unavailable: the snapshot digest does not bind its contents";

export const PUBLICATION_INPUT_DETAIL =
  "publication validation unavailable: expected exact base, head and optional published head commit SHAs with bounded protected paths";

export const PUBLICATION_PROTECTED_INPUT_DETAIL =
  "publication validation unavailable: protected paths are malformed or over bound";

export const PUBLICATION_DEADLINE_DETAIL =
  "publication validation unavailable: the bounded publication validation deadline elapsed";

export const PUBLICATION_READ_DETAIL =
  "publication validation unavailable: a trusted Git object read did not settle with exit 0";

export const PUBLICATION_UNSETTLED_DETAIL =
  "publication validation unavailable: a trusted Git object read did not prove process settlement";

export const PUBLICATION_OVERBOUND_DETAIL =
  "publication validation unavailable: a trusted Git object read exceeded its finite output bound";

export const PUBLICATION_COMMIT_DETAIL =
  "publication validation unavailable: base, head or published head is not the exact commit object requested";

export const PUBLICATION_STALE_BASE_DETAIL =
  "publication validation unavailable: base is not an ancestor of head (stale base)";

export const PUBLICATION_PUBLISHED_HEAD_DETAIL =
  "publication validation unavailable: the prior published head is not an ancestor of head";

export const PUBLICATION_EMPTY_DETAIL =
  "publication validation unavailable: the publication exposes no new commit to validate";

export const PUBLICATION_COMMIT_BOUND_DETAIL =
  "publication validation unavailable: the newly exposed commit bound was exceeded";

export const PUBLICATION_OBJECT_BOUND_DETAIL =
  "publication validation unavailable: the newly exposed object bound was exceeded";

export const PUBLICATION_LIST_DETAIL =
  "publication validation unavailable: a bounded Git object list is malformed";

export const PUBLICATION_BOUND_DETAIL =
  "publication validation unavailable: the aggregate inspected metadata and blob bytes exceeded their finite bound";

export const PUBLICATION_METADATA_DETAIL =
  "publication validation unavailable: newly exposed commit metadata is not bounded text";

export const PUBLICATION_METADATA_BOUND_DETAIL =
  "publication validation unavailable: newly exposed commit metadata exceeded its finite content bound";

export const PUBLICATION_METADATA_SECRET_DETAIL =
  "publication validation unavailable: newly exposed commit metadata contains secret-shaped text";

export const PUBLICATION_ISSUE_DETAIL =
  "publication validation unavailable: newly exposed commit metadata contains an issue-closing reference";

export const PUBLICATION_PROTECTED_DETAIL =
  "publication validation unavailable: a protected entry does not match the trusted base tree";

export const PUBLICATION_STRUCTURE_DETAIL =
  "publication validation unavailable: a parent edge has an unsafe, unsupported or over-bound structural change";

export const PUBLICATION_PATH_DETAIL =
  "publication validation unavailable: a parent edge changed path is unsafe or over bound";

export const PUBLICATION_MODE_DETAIL =
  "publication validation unavailable: a parent edge changed path has an unsupported Git mode";

export const PUBLICATION_SYMLINK_DETAIL =
  "publication validation unavailable: newly exposed symlinks are unsupported";

export const PUBLICATION_SUBMODULE_DETAIL =
  "publication validation unavailable: newly exposed submodules are unsupported";

export const PUBLICATION_STATUS_DETAIL =
  "publication validation unavailable: a parent edge changed path has an unsupported status";

export const PUBLICATION_BINARY_DETAIL =
  "publication validation unavailable: a newly exposed blob is binary";

export const PUBLICATION_UTF8_DETAIL =
  "publication validation unavailable: a newly exposed blob is not valid UTF-8 text";

export const PUBLICATION_FILE_BOUND_DETAIL =
  "publication validation unavailable: a newly exposed blob exceeded its finite content bound";

export const PUBLICATION_SECRET_DETAIL =
  "publication validation unavailable: a newly exposed blob contains secret-shaped text";

/**
 * Publication failures that are determined by the immutable candidate. These
 * must not be reported as transport unavailability: preservation can settle a
 * submitted attempt only when the caller can distinguish a permanent content
 * refusal from a retryable Git/read failure.
 */
export const DETERMINISTIC_PUBLICATION_DETAILS: readonly string[] = [
  PUBLICATION_OVERBOUND_DETAIL,
  PUBLICATION_COMMIT_DETAIL,
  PUBLICATION_STALE_BASE_DETAIL,
  PUBLICATION_PUBLISHED_HEAD_DETAIL,
  PUBLICATION_EMPTY_DETAIL,
  PUBLICATION_COMMIT_BOUND_DETAIL,
  PUBLICATION_OBJECT_BOUND_DETAIL,
  PUBLICATION_LIST_DETAIL,
  PUBLICATION_BOUND_DETAIL,
  PUBLICATION_METADATA_DETAIL,
  PUBLICATION_METADATA_BOUND_DETAIL,
  PUBLICATION_METADATA_SECRET_DETAIL,
  PUBLICATION_ISSUE_DETAIL,
  PUBLICATION_PROTECTED_DETAIL,
  PUBLICATION_STRUCTURE_DETAIL,
  PUBLICATION_PATH_DETAIL,
  PUBLICATION_MODE_DETAIL,
  PUBLICATION_SYMLINK_DETAIL,
  PUBLICATION_SUBMODULE_DETAIL,
  PUBLICATION_STATUS_DETAIL,
  PUBLICATION_BINARY_DETAIL,
  PUBLICATION_UTF8_DETAIL,
  PUBLICATION_FILE_BOUND_DETAIL,
  PUBLICATION_SECRET_DETAIL,
];

/**
 * Fixed global argv: no optional locks, no pager, literal pathspecs, no
 * fsmonitor, no hooks, no external diff, no text conversion and no credential
 * helper. Combined with the cleared child environment
 * (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at /dev/null,
 * `GIT_CONFIG_NOSYSTEM=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_OPTIONAL_LOCKS=0`,
 * `GIT_NO_LAZY_FETCH=1`, empty `GIT_ALLOW_PROTOCOL`) no host, global,
 * replace-object, promisor or transport configuration can influence a read.
 */
export const GIT_FIXED_ARGV: readonly string[] = [
  "--no-optional-locks",
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "core.safecrlf=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "diff.external=",
  // Clear any configured credential helper: a trusted read never authenticates
  // and never executes a host-configured helper.
  "-c",
  "credential.helper=",
];

/**
 * Every diff read forces `--ignore-submodules=none` so repository-local
 * `diff.ignoreSubmodules` (or an ignore rule from any config source) can never
 * hide a gitlink change before it is rejected as unsupported.
 */
export const NO_SUBMODULE_IGNORE = "--ignore-submodules=none";
