# Reviewing a task that produced no change

An authenticated `model_candidate_unchanged_base` outcome is a reason to review
the task against the exact base. It is never evidence that the task is already
satisfied. The implementation reservation remains charged. This route handles
issue tasks with no pull request or candidate; correction attempts retain their
ordinary failure path.

The trusted coordinator records an indefinitely waiting `backoff` using existing
V1 work fields. Its original implementation intent carries an authored
`base_review` failure marker. The normal selector, including R80, skips it. R81
alone recognizes the marker in a phase before ordinary selection. Historical
exact no-change failures with their charged implementation intent can enter the
same path. Generic unavailable failures cannot.

Before native review, the coordinator reads the current issue, digest and base,
requires that base's CI, and reserves a `review_request` through the existing
budget. The record's existing `reviewRoundCeilingFor` allowance includes all previous admissions and ambiguous starts; current-era and legacy ceilings remain distinct, and this route grants no additional round. An existing `issue_closure` intent carries the exact base,
task digest, implementation reservation and review admission while the
nonexpiring wait keeps R80 inert. No review request ever carries a fabricated
pull request number.

The existing structured reviewer inspects a read-only exact base checkout with a
base-equals-head snapshot. Empty snapshots require a validated task statement;
ordinary candidate publication still rejects empty changes. The protected parent
owns native session handles, with ephemeral issue-review custody registration
and no new stdout settlement variant. Interrupted or ambiguous outcomes stay
charged. Before the native start, a comment records the existing running
execution payload and is read back exactly; it authorizes no closure.

Two authenticated issue comments retain native evidence independently: one is
the existing `ReviewResultV1`, the other is the existing
`ReviewJournalReadyExecutionV1`. They use the existing strict parsers, including
R80's parsers, and are not wrapped in a new receipt or journal shape. An
existing `review_receipt` evidence reference binds their comment ids and digests
to the exact issue, base, task digest and review admission. The trusted
coordinator alone creates the binding; model output cannot choose it.

Only an authenticated completed native result with no unresolved P0 and `already_satisfied_at_base` for the exact task permits issue closure. P0 is the only severity-based blocker; other findings remain retained and their follow-up uses the existing authorized issue workflow. The
closure capability re-reads both comments, verifies their author and complete
digests, checks their existing native result and execution shapes, and re-reads
issue text, configured base and CI immediately before the issue-only write. Base
or task drift invalidates the review. A missing, edited or foreign comment
cannot authorize closure. No PR is created, merged, closed, or deleted.

The closure intent is durable before any issue mutation. An ambiguous close
retains it and is reconciled through the same exact evidence on a later run.
After a confirmed close the task is done; it produces no release request or
fulfilled repair claim. There are no new durable state, plan, cell, model
receipt or stdout variants. R80 parses every payload and skips unfinished work
through the nonexpiring wait.
