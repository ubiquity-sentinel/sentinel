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
    "src/repair/merge-gate-checks.ts",
    "src/repair/ci-rejection.ts",
    // The policy half split out of that CI verdict dependency: editing
    // it alone must not weaken the exact-head check verdict.
    "src/repair/ci-correction-policy.ts",
    // Owner-landing merge refusal: the protected-touch classification, the
    // publication protected set and the delivery that never merges a
    // protected change. A candidate weakening them could auto-merge itself.
    "src/repair/owner-landing.ts",
    "src/repair/loop-owner-landing.ts",
    // The 2026-11-17 safeguards: each decision, the inputs its verdict
    // depends on, and every executor that applies it whatever its caller
    // does. Issue admission (owner and App only) and the workflow-trust
    // decision with what they read (the App identity and base-repair shape,
    // the author id parse); the push backstop, the push executor that runs
    // it on the local tree diff and the candidate preserver that runs it on
    // every hosted model candidate; the CI integrity rule; the merge
    // executors' content gate and the native self merge; the launcher's file
    // gates and the train that calls them. The repair loop files that call
    // these, and the target policy lists (2026-10-30), stay ordinary work:
    // no one of them is the only barrier to a push or a merge.
    "src/repair/issue-admission.ts",
    "src/repair/workflow-trust.ts",
    // 2026-11-18 ("no private repos"): the one predicate that decides which
    // target repositories Sentinel works, and how GitHub's answer is read;
    // the launcher's gate that applies it to every maintenance pass, and the
    // launcher surface's repository read that answers it.
    "src/repair/target-visibility.ts",
    "ops/hosted-autonomy-private-targets.ts",
    "ops/hosted-autonomy-github-repository.ts",
    "src/repair/base-repair.ts",
    "src/github/wire.ts",
    "src/github/wire-issue-author.ts",
    "src/repair/push-guard.ts",
    "src/github/push-content-guard.ts",
    "src/github/port-publication.ts",
    "src/github/git-executor.ts",
    "src/host/actions-candidates-preserve.ts",
    "src/repair/ci-success-rule.ts",
    // 2026-11-18: the small modules that define the rules' remaining inputs
    // (the capability notice's trust markers, the CI rule's merged-head
    // listing and the change-set reader). The large files that call them
    // (`target-capability.ts`, `client-reads.ts`, `port-base.ts`) and the
    // admission callers in the repair loop stay ordinary: the merge executor
    // (`port-merge.ts`) re-checks admission on its own issue read.
    "src/repair/trust-markers.ts",
    "src/github/merged-pull-heads.ts",
    "src/github/changed-paths-read.ts",
    // The launcher admission gate's author parse (the gate itself lives in
    // the owner-merged `ops/hosted-autonomy-pull-file-gates.ts`).
    "ops/hosted-autonomy-issue-facts.ts",
    "src/github/merge-content-gate.ts",
    "src/github/port-self-merge.ts",
    "ops/hosted-autonomy-pull-file-gates.ts",
    "ops/hosted-autonomy-train-members.ts",
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
    // Its per-target mirror preparation: which remote each foreign mirror is
    // seeded and fetched from with the selected write credential.
    "src/host/actions-target-preparation.ts",
    "src/host/actions-supervisor-host.ts",
    "src/host/hosted-app-principal.ts",
    "src/contracts/hosted-supervisor-verification.ts",
  ]);

/**
 * The Sentinel template's remaining authority entries, protected after the
 * hosted set (`createLocalRepositoryConfig`).
 */
export const LOCAL_AUTHORITY_PROTECTED_PATHS: readonly string[] = Object
  .freeze([
    // Sentinel's own workflows: on this repository a `.github/` change is
    // never published (a pushed workflow would run with Sentinel's secrets
    // and a writable token before the owner saw it; `owner-landing.ts`). On
    // a target, a workflow change publishes only on a trusted source and
    // merges only under the CI integrity rule (2026-11-17).
    ".github/workflows/",
    // The unchanged `touchesProtected` predicate itself: a candidate edit
    // could make the whole boundary return false after merge.
    "src/repair/loop-records.ts",
    // This file decides the protected set itself.
    "src/host/local-config.ts",
    // The trusted supervisor's exact-revision promotion boundary: the
    // pointer writer (`active-runtime.json`, compare-and-set under the
    // supervisor lock), the callers that decide promotion and the receipt
    // parser they rely on.
    "src/host/local-release.ts",
    "src/host/local-supervisor-release.ts",
    "src/host/actions-supervisor-installation.ts",
    "src/host/local-supervisor.ts",
    "src/host/actions-supervisor-source.ts",
    "src/host/actions-supervisor-controller.ts",
    "src/host/actions-supervisor-install-api.ts",
    "src/contracts/local-release.ts",
  ]);

/**
 * Sentinel's own authority (owner decision 2026-10-30): every entry above.
 * A configured protected change to one of these stays forbidden AND
 * unpublished; it never becomes an owner-landing publication.
 */
export const SENTINEL_AUTHORITY_PATHS: readonly string[] = Object.freeze([
  ...HOSTED_AUTHORITY_PROTECTED_PATHS,
  ...LOCAL_AUTHORITY_PROTECTED_PATHS,
]);
