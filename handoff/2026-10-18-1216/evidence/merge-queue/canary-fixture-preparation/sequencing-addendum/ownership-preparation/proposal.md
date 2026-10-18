# Canary PR ownership proposal

Use the available authenticated owner identity `0x4007` and the existing shared
tracking issue `ubiquity/sentinel#164`. At 2026-10-18 07:11 UTC, native reads show
that issue OPEN and already assigned to0x4007, with admin repository role in
both Sentinel and ai.ubq.fi. This satisfies the user's self-assignment route
without any new issue or redundant assignment mutation. The nine fixtures are
parts of that one rollout task; no per-fixture dummy issues are justified.

These are read-only findings. No issue, assignment, PR, comment, branch, source,
owner packet, or ledger was changed. Native PR165 now reports merged; issue163
was still open and assigned to0x4007. This preparation leaves both untouched.

## Safe creation sequence after owner canary approval

1. Re-read authenticated `/user`, actual repo permission/role, and issue164's
   state/assignees immediately before fixture creation. Confirm the actual PR
   author will be0x4007 and its existing assignment remains. Git commit author
   or coauthor text is not GitHub PR authorship. A changed identity, closed task,
   missing assignment, or unavailable role is a new ownership fact to reconcile.
2. Refresh matching canary refs/PRs before creating each phase fixture. Reuse an
   existing eligible PR and branch, retaining its real author and history. Do
   not create a replacement simply because a prior PR exists or was closed by
   automation. Reconcile its native state first; do not add metadata edits as a
   speculative way to reopen it.
3. Create only the phase-needed fixture under0x4007 with the reviewed branch,
   head and full prepared body. Preserve the normal non-closing reference:
   `Tracking: ubiquity/sentinel#164`. Do not claim an individual fixture resolves
   the whole rollout, add unrelated closing links, or depend on a PR template
   to create the association. There is no need to invoke `/start`: assignment
   already exists, and that command has separate eligibility and side effects.
4. Inspect the first created PR after opened-event automation has settled. Read
   native author/base/head/state, complete closingIssuesReferences, and any
   closure event/comment. Verify it remains open before proceeding with further
   fixtures and before granting enqueue. Recheck the assignment if automation
   produces an unexpected result. Do not substitute a body keyword, plain
   cross-reference, issue timeline mention, or an empty association for an
   observed native closing link.
5. On the nondefault queue-canary base, a native closing association is not
   presumed. If one is present, confirm its issue is OPEN and assigned to the
   actual PR author; avoid any additional open unassigned closing issue. If
   none is present, report that accurately: the retained policy's independent
   noncontributor rule explains why the owner-authored PR may remain open.
   The existing issue assignment still satisfies the explicit ownership
   requirement; it is not mislabeled as a native closing-link receipt.
6. Keep metadata stable once correct. Head updates required by a canary scenario
   remain scoped and reviewed; title/body edits can retrigger the bot's opened/
   edited policy. If the PR closes unexpectedly, stop new fixture creation,
   retain native cause/evidence and recover that same PR through the coordinator
   after resolving the actual cause. Do not duplicate it or claim that an admin
   role guarantees behavior of an unverified deployed plugin.

The user's alternative of Sentinel-bot authentication requires actual trusted
App authentication; it cannot be simulated with commit metadata. It is not
needed for this route. The public handler has no Bot-type exemption: a Bot
classified as contributor can still be closed without a usable author-assigned
native link. Runtime credentials stay in the protected host; this proposal
requests no token/key and adds no model-worker authority.

## What the inspected policy establishes

Pinned public source is
`ubiquity-os-marketplace/command-start-stop@5d5edec7dcb59c3e1d5e3e2f89674fe9c677ceb6`.
Deployed equivalence remains unverified. Relevant exact source behavior:

- `src/handlers/new-pull-request-or-edit.ts:82–104` reads native paginated
  closingIssuesReferences, filters closed issues out, and leaves a PR open
  when there is no open unassigned linked issue and at least one open linked
  issue is assigned to the PR author. It does not count other PRs using that
  issue. One genuine shared task can support multiple PRs.
- Lines107–119 independently leave noncontributors open when no eligible
  unassigned issue exists; contributors can be closed. Role resolution first
  tries organization membership, then repository role, and falls back to
  contributor when unavailable. Native owner/admin role supports the expected
  path, but does not prove the plugin's own lookups succeeded.
- An open unassigned closing issue takes precedence at98 even if another
  closing issue is assigned to the author. Lines122–168 invoke startTask, and
  a non-OK result or exception closes the PR. Avoid adding unrelated links.
- `evaluate-eligibility.ts:55–93` requires a price label for contributors,
  rejects parent/closed/already-assigned issues in its separate start path;
  other start checks still apply. Admin price/label exemptions do not make
  automatic `/start` a needed or risk-free operation. Preassignment and the
  no-auto-start branch avoid this path.
- `src/plugin.ts:22–26` handles PR opened/edited and issue unassigned. It has
  no PR reopened or issue closed case. There is no default-base or draft
  exception in the PR handler.

## Closing and unassignment lifecycle

Keep issue164 open and its owner assignment intact while canary work is active.
Do not use `/stop` or unassignment as cleanup. `stop-task.ts:24–39` calls the
linked-PR closure helper before removing the author. The issues.unassigned
handler likewise calls that helper for the removed assignee, without the PR
handler's admin exemption. Shared tracking means a stop/unassignment can affect
multiple linked PRs; it is not evidence that separate dummy issues are needed.

Exact cross-repository closure success is not established: the helper enumerates
linked open PRs and filters same author/organization, but its close request uses
the webhook context repository and each PR number (`utils/issue.ts:47–53,65–100`).
Do not rely on that mismatch as protection or claim it certainly closes every
ai.ubq.fi fixture. It establishes potentially destructive side effects and a
reason not to invoke that path. No fix or live probe is proposed here.

Issue closure alone has no direct handler in this inspected plugin. It does
remove the open-assigned-link protection on later PR metadata events because
closed issues are filtered out. Other deployed automation is not proven absent.
Avoid closing the tracking task prematurely through fixture closing keywords,
and distinguish eventual legitimate issue completion from unassigning/stopping
active fixture work. Never close PRs or delete branches as this preparation's
cleanup.

Native read receipts, pinned missing helper source, and focused source notes
are retained alongside this proposal. The original fixture and sequencing
manifests remain unchanged; this is a separate evidence addendum only.
