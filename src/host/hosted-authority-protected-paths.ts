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
    // Native-token auto-follow: the launcher SHA choice, the exact-head CI and
    // ancestry proof, the `actions: write` dispatch that advances
    // `sentinel-supervisor`, the API bearer token and `updateRefs` mutation,
    // the installed/failed revision state and the adapter that reads
    // `GITHUB_TOKEN` and writes the dispatch outputs.
    "src/host/hosted-runtime-follow.ts",
    "src/host/hosted-runtime-follow-ci.ts",
    "src/host/hosted-runtime-follow-dispatch.ts",
    "src/host/hosted-runtime-follow-api.ts",
    "src/host/hosted-runtime-follow-state.ts",
    "src/host/hosted-runtime-follow-main.ts",
    ".github/actions/hosted-runtime-control/",
    // Expected-head merge gate: effective protections, their evaluation, the
    // merge itself and the CI dependencies that decide a green conclusion.
    "src/github/port-evidence.ts",
    "src/github/port-merge-policy.ts",
    "src/github/port-merge.ts",
    "src/repair/loop-checks.ts",
    "src/repair/ci-rejection.ts",
    // Per-run credential selection and per-target token binding: the mint
    // action, self-versus-target token selection, grant parsing, target cycle
    // selection, the host composition that chooses the write tokens and
    // admits model starts, the App-principal capture and the hosted admission
    // predicate they trust.
    "src/host/hosted-app-credentials.ts",
    ".github/actions/sentinel-app-token/",
    "src/host/actions-target-bindings.ts",
    "src/host/hosted-app-grant.ts",
    "src/host/actions-target-cycles.ts",
    "src/host/actions-repair-host.ts",
    "src/host/actions-supervisor-host.ts",
    "src/host/hosted-app-principal.ts",
    "src/contracts/hosted-supervisor-verification.ts",
  ]);
