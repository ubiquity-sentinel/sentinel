/**
 * Host-owned authority source; model candidates may not rewrite these boundaries.
 *
 * Owner directive 2026-10-30: keep only the files that mint or select
 * credentials, dispatch with write tokens, evaluate the merge gate, or promote.
 * Review parsing, queue plumbing, retention, notification and base-review files
 * are ordinary candidate work.
 */
export const HOSTED_AUTHORITY_PROTECTED_PATHS: readonly string[] = Object
  .freeze([
    "src/host/hosted-authority-protected-paths.ts",
    // Trusted controller placement: a candidate must never retarget the
    // controller repository, branches or workflows.
    "src/contracts/hosted-controller-deployment.ts",
    // Token-bearing scheduled entrypoint (`supervisor-dispatch.yml` runs the
    // default branch every five minutes with `actions: write` and
    // `contents: write`) and the pre-merge CI dispatch on the target token.
    "src/host/supervisor-dispatch.ts",
    "src/host/actions-premerge-ci.ts",
    // Expected-head merge gate: effective protections, their evaluation and
    // the exact-head check verdict.
    "src/github/port-evidence.ts",
    "src/github/port-merge-policy.ts",
    // Per-run credential selection and per-target token binding.
    "src/host/hosted-app-credentials.ts",
  ]);
