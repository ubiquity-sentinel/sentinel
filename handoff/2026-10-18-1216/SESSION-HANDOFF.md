# Sentinel handoff — 2026-10-18 12:09 UTC

The user requested an immediate handoff. Work is paused. This document is a continuation snapshot, not permission to activate anything. Read the original user goal and repository AGENTS.md, MASTER-PLAN.md, docs/DECISIONS.md and docs/build-status.md. The latter remains the sole authoritative acceptance ledger; its latest prose predates the last accepted local tranches below and needs reconciliation by the next primary.

## Start here

1. Preserve the dirty work described below. Exact copies and tracked patches are alongside this README; `workspace-snapshot.json` binds every path, HEAD and file hash.
2. Finish the missing-App-principal routing regression on the actual host. The source-only helper is committed, but host wiring and connected tests are still dirty and not accepted.
3. Integrate those changes, finish the pending authority-path changes, run the narrow combined checks, and obtain the fresh auditor's final exact-candidate assessment.
4. Observe development CI run **39124867746**. Do not rerun blindly. It is still running as of the handoff.
5. The isolated merge-queue canary still requires the owner's pending approval. Do not create fixtures/rulesets or dispatch canary effects until that reply arrives.

The latest user correction is binding: **reuse already-open PRs; authenticate runtime effects as ubiquity-sentinel[bot], or assign the authenticated human to the source issue for manual work. Ubiquity OS otherwise closes the PR.** Do not open replacements merely because a referenced task already has a PR.

## Live state and authentication

| Surface | Exact state |
| --- | --- |
| Installed runtime | R81 `da98f5f49c45b57cfa97a45fe647c36b1021f302`, generation 81 |
| Live launcher / sentinel-supervisor | L81 `00b6649eeff51a9754bf3748f793137db9bf8605` |
| Sentinel development | `12bc367852188aa94132b7658d774ec413295c1d` (reverified at handoff) |
| Last verified AI development | `984aa8a63183d60a15036321d2dc7aefd8e5d1b3` |
| sentinel-release | Disabled manually; keep disabled |
| Production queue | Off; no active AI production queue rule, no queue runtime installed |
| Shell/manual identity | `0x4007`; issue sentinel#164 is open and assigned to this account, reverified 12:02 |
| Runtime App | ubiquity-sentinel, App 4682172, installation 155687488, client ID `Iv23liHUJNXds9mU3j7Q` |

App suspension/write-access trouble was resolved. The owner already granted and accepted **Merge queues: Read and write**. Do not ask for that permission again or ask the user to log in again without a fresh failure.

All four supervisor model expressions remain `${{ vars.SENTINEL_IMPLEMENTATION_MODEL_ID || 'gpt-6.1-sol' }}`. Separate owner documentation/configuration now records the existing `gpt-reserve` implementation override; preserve it. Do not infer a live provider/model from an alias or change routing as part of this handoff.

R81 is stable on the accepted evidence. Latest root-accepted ordinary run: **39118222197**, all 11 jobs green; evidence `/workspace/evidence/gen81-live/latest-ordinary-refresh/root-runtime-acceptance.json`.

A newer read-only worker refresh found ordinary run **39121306436**, repair **117659216668**, all 10 jobs green (five cells), all sixteen identity/health gates, healthy/settled/startup-ready exact R81/L81. Authoritative release state: `a61eb72db8ab1f43cd5a88e07469d909612bf7f9`. Native normalized log SHA-256: `7e13ac42e29224e87dbfb54eae29e8b47076de7464822a1cb0ca48519f187a7d`, 72,637 bytes. Evidence is frozen at `/workspace/evidence/gen81-live/refresh-1205/manifest.json`, 41 files, manifest SHA-256 `83f5e7c8f3644d31ddff0dbfbbc8bd530821d47d9a310d225af43ca9dcbd16e3`. **Root independent acceptance of this newer refresh remains pending.** Next ordinary run 39124004191 had four cells successful and repair117666860222 running. Five canceled queued dispatches had zero jobs; no runtime failure is inferred. No new delivery attribution is claimed.

## Already completed — do not redo

- Original index was read at `be02faf40c77fe299c2ed7ffa91fedb00fe43c48`, `handoff/2026-10-18/README.md`, branch `claude/practical-planck-34q9mt`.
- AI PR1159 merged normally at `4c189c05d78f723fcbf06063f1624e35949332d1`, exact head `0a7063f994f39d958476d9257c2eef7ce9a7abc9`. Conflict resolution changed only docs/DECISIONS.md and retained both G3 facts; all four checks green. Follow-up1182 contains the retained P3. Evidence `/workspace/evidence/finish-1159/`.
- AI PR1180 merged `624466337a9e92e9f36385d8801b29807e41ccb9`, exact head `5b080ea0e0947c76230a0d08854e584f4771c9ab`: development runs no longer cancel; merge_group checks supported; PR/group runs do not deploy. Evidence `/workspace/evidence/ci-base-runs/final-5b080ea0/`.
- AI existing PR1207 merged `730218b0c89d479b141c4a2fa17ad5ee363f161a`, exact head `1ade164ef78e7fa919ec5a502a6f3c42864e790c`, seven real checks green and independent current-head review passed. Postmerge730 also passed all seven, without CI deployment. Source issue1206 closed by merge, assignment retained. Evidence `/workspace/evidence/ci-required-checks/current-base-6414/merge/` and `postmerge-730218b0/`.
- Generation81 is integrated through original PR165, merge `c2177dfdfa563938558caf16b783aaf942af3fb7`, installed and verified in ordinary runs. All eleven lane ancestors retained, output-volume bound removed safely, unchanged-base route implemented, incidental throughput limits lifted, owner parks summarized. Exact R81 normal and depth-one checks, R80 parsing, combined adversarial review and native CI passed. Issue163 closed. Evidence `/workspace/evidence/gen81-final-validation/`, `gen81-hosted/`, `gen81-pr165/`, `gen81-install/`, `gen81-live/`.
- Dormant queue source at `2b32bdbd449cbc615c239af40474941cefcb0c55` passed exact native CI39117211579 (3,218 tests / 1,298 steps). This is source acceptance, not queue activation.
- Sentinel original PR160 was retained, reviewed and normally SHA-pinned merged as `9b7c3e5cec4d45c4e0985ab28bd524b4bb69237b` from head `21384b8a9c4b80278f1e613096a7d2e3d3c3eadf`. Exact PR CI39117497198 passed 3,225 tests / 1,305 steps. Issue157 closed, assignment0x4007 retained, branch retained. Evidence `/workspace/evidence/pr160-continuation/second-corrected-base-validation/merge/`.

## Published fixture correction: native CI still pending

PR160's same-tree postmerge CI39121415774 failed one local Git-clone fixture setup, an object-copy ENOENT before the actual scenario. 3,224 tests / 1,305 steps passed. A local clone/repack race reproduced the failure class; the exact native interleaving is unproven.

Correction **12bc367852188aa94132b7658d774ec413295c1d** adds `--no-local` plus a comment in `tests/host/hosted-autonomy-historical-fixtures.ts` and refreshes the ledger. No production/workflow source changed. All nine local checks, 29 unique affected cases and fresh independent Sol/max assessment passed. It was fast-forwarded to development; sentinel-supervisor stayed L81.

Native CI **39124867746**, attempt1, job **117667744672**, suite106024605634, GitHub Actions App15368, started11:52 UTC and is **in_progress** at12:09. URL: https://github.com/ubiquity/sentinel/actions/runs/39124867746 . Exact tree `ad4690926d06418adba17d6dc383c881e85d45e6`. Observe completion and verify exact checkout/full harness; diagnose any failure before another run. Evidence `/workspace/evidence/pr160-continuation/postmerge-9b7c3e5/fixture-correction/`, particularly `root-acceptance.json`, `publication-result.json` and `native-ci/`.

## Local integration: exact ownership and dirty files

All takeover source remains **inactive and unpublished**: source profiles `[]`, takeover admission false, queue proof false, custody activation false, future revision/migration/grant arrays empty. No installation or live adoption claim.

| Worktree / branch | HEAD | Remaining dirty work |
| --- | --- | --- |
| `/workspace/worktrees/existing-pr-root-wiring`, `codex/existing-pr-root-wiring` | `80e7a3dcede4eea1c9325ba4338098f986b8336e` | Three authority protection/test files below |
| `/workspace/worktrees/existing-pr-integration`, `codex/existing-pr-integration` | `80e7a3dcede4eea1c9325ba4338098f986b8336e` | `src/host/actions-repair-host.ts` only; source-routing wiring, 29 added /16 removed lines after formatting |
| `/workspace/worktrees/existing-pr-principal`, `codex/existing-pr-principal` | `5321a4e682cbcb329ed39e6b9639a793f67f4ca5` | Two modified principal fixture/test files plus new routing test below |
| `/workspace/worktrees/ci-fixture-clone`, `codex/ci-fixture-clone` | `12bc367852188aa94132b7658d774ec413295c1d` | Clean |

Root dirty files:

- `src/host/hosted-authority-protected-paths.ts`
- `src/host/hosted-runtime-frame-labels.ts`
- `tests/host/hosted-authority-protected-paths_test.ts`

They protect/name the exact new helpers `actions-queue-custody.ts`, `maintenance-existing-pr-publication.ts`, `hosted-app-takeover-routing.ts`. Actual forbidden-candidate consumer tests passed 3 cases /10 steps; scoped fmt/lint passed. Then the negative frame inputs were moved before the six-frame ceiling to preserve the existing rejection test; that filtered case passed. Final scoped formatting on the reordered test is still due. Receipts: `/workspace/evidence/existing-pr-root-wiring/protection-helper-*-receipt.json` and `protection-frame-negatives-receipt.json`.

Principal dirty files:

- `tests/host/actions-existing-pr-principal-fixtures.ts`: real initial unmarked linked-issue fixture and connected admission proof.
- `tests/host/actions-existing-pr-principal_test.ts`: forged/native-fallback metadata now expects restrictive coordination true, retaining every zero-effect assertion; this is an authorized semantic assertion update.
- New `tests/host/actions-existing-pr-routing_test.ts`: actual-host route/create and prepareImplementationStart regression. **Not yet GREEN with integrated host wiring.**

All indices were empty before the snapshot. No local validation/model subprocess was running at12:09 process inspection. All coding/review/CI-observer agents are interrupted or completed after the user requested the handoff. GitHub Actions continues independently. Do not assume an interrupted worker finished its pending checks.

Tracked dirty patches and exact dirty/untracked file copies are saved next to this README. Do not reapply them over the already-dirty worktrees. They are recovery artifacts, not accepted commits.

## Accepted local tranches and behavior

Root80e7 retains accepted ancestry, including published12bc. Use Git ancestry rather than cherry-picking duplicates. Important tips:

| Tranche | Accepted tip / evidence |
| --- | --- |
| Shared discovery/coordinator contracts | `05750884af279b98884aed947ee6b97d21502886`; 78 tests/156 steps |
| Runtime fence/data/rollout | `6611e68a`, `9924b536`, `6765f49d`; defaults off |
| Same-mint App action | `aff1652d`; 19 actual mint/post tests |
| Private App principal | `3265be63c0653f417e80d072fec1a33c6cc5f589` |
| Offline self dependencies + actual host | `b902ffa0`, `9d163bd4`, `07c70725496823676aa76fbb051fb96a955f3845` |
| Parent mint verification | `3721d74b83e5b580278e84fa061fd3d780654b9e`; 41 tests/69 steps |
| Maintenance migration | `8a9bc766225e5561fad59eff36ac16399afdb9c9`; 49 tests/70 steps |
| Original-PR lifecycle | `d680acd5a8afc58e0a4844d98438819c0bc21794`; 186 tests/246 steps |
| Migration workflow predicates | `d94dfb80b637613749a5755b841a79798ef75df9`; 22 affected tests |
| Authority path/closed frame base | `aa9259585f5389984b72f97b10cb725f84634e13` |
| Same-token actual-host effects | `a93c30e678f2525c9ca0aba87d7ddf48ca2f5921`; 39 tests/42 steps |
| Actual queue prelude + read-only maintenance publication | `5c8907ea783b82f9b9d6bb189b3e933a0a0bcecc`; 39 tests/33 steps |
| Source-only restrictive routing helper | `5321a4e682cbcb329ed39e6b9639a793f67f4ca5`; 3 tests/6 steps |

Principal binds actual same-token native execution, exact clean launcher/runtime source, saved health, permissions and repository scope. Source profiles authenticate tracked source/action/dependency configuration; only three strictly parsed data files are excluded from the code digest to avoid an R/L pin cycle. Final App-scope freshness previously allowed drift before a real push; a93 fixed this with full source/native/state rechecks, causal RED→GREEN and zero pushes on refusal. Takeover admission and persistent custody are separate data fields.

Original native PR heads are preserved as honest immutable anchors, without fabricated implementation reservations. Real successors/refreshes retain the original branch/PR and real charged provenance. Read-only publication proofs survive admission-off and closed source issues; mutation proofs remain one-use and fresh. Existing source accounting is never refunded. Adopted Sentinel self-merge remains an explicit owner gate; genuinely conflicting adopted base refresh currently refuses before a new model charge because that producer is not supported yet. Closed-publication custody holds preserve the PR/branch. Do not silently widen these gates.

The actual ordinary host now runs queue custody before task cycles, uses its cached same-token GitHub port and rereads state after custody CAS. Queue holds produce honest idle and existing zero-grant matrix plans; a real bounded availability probe still owns startupReady. Cells never get a queue writer. Nonordinary bootstrap/prior/candidate/rollback only observes native no-custody evidence. Maintenance gets a frozen `resolvePublication` surface backed by real immutable Git/state-history proof in a private bare store, read-only HTTP/state facades, false policy/runtime/Contents gates and no principal. The worker's cold-bootstrap subprocess used committed predecessor ee10183: **rerun the existing cold bootstrap on the final combined commit**.

Accepted evidence roots:

- `/workspace/evidence/existing-pr-principal-launcher/`
- `/workspace/evidence/existing-pr-principal-effects/` (`root-effect-tranche-acceptance.json`)
- `/workspace/evidence/existing-pr-maintenance-composition/`
- `/workspace/evidence/existing-pr-lifecycle-integration/implementation/`
- `/workspace/evidence/existing-pr-lifecycle-integration/host-queue/` (`root-acceptance.json`, `committed-input.json`, `frozen-manifest.json` SHA `613bb6872f717ab7ba93b463fcd25ca001e0dd92b1e3970cf6cd50505f43fee4`)
- `/workspace/evidence/existing-pr-principal-routing/` (`helper-root-acceptance.json`, `helper-manifest.json` SHA `5627a36f78b14a9127a0677aafb95b0fa5966cb5892bbff1f2d04961dc7acafe`)

## Open P1 and immediate integration sequence

**Confirmed P1:** actual launcher admission true plus runtime-compiled admission false, when grant/native/source proof fails, produced null principal context and fell back to a default inactive local port. An unmarked issue already linked to an open PR could therefore start replacement work. Real `prepareImplementationStart` reproduced `prepared=true` and one durable reservation; route/create authorization also wrongly passed. No model was invoked. RED receipts/logs: `/workspace/evidence/existing-pr-principal-routing/missing-grant-routing-red*` and `missing-grant-admission-red*`.

Accepted helper `readHostedAppTakeoverRouting(source, trustedProfiles?)` returns `inactive|required|unknown`, independent of credentials/grants/native HTTP. Strictly parsed runtime-owned `[]` plus imported compiled admission false is the sole intentional unconfigured shortcut; it is explicitly **not proof about current L policy**. Otherwise authenticated actual L false→inactive, true→required, unknown/malformed/drift→unknown. Never derive admission from the custody floor. This helper can restrict coordination only, never issue principal/effect authority.

The dirty host seam reads that helper before optional principal creation, sharing the exact source input. Its null-context `composeLocalGitHub` call gets only the third policy argument `{activated: takeoverRouting.status !== 'inactive'}`. No principal/Contents/runtime permission is added.

Resume sequence:

1. Reconcile snapshots and pending native CI/health. Read the actual dirty host and three connected test files.
2. Validate and accept the one-file host seam against helper, queue host and unaffected principal cases. The old forged/native-fallback assertion is intentionally stale; the principal lane already holds its narrow correction. Preserve all zero-effect assertions.
3. Root alone commits the accepted host file and merges normally into root. Then normally merge that root input into principal lane while preserving its three dirty test files. Do not reset/stash away work or mutate HEAD during a running check.
4. Run actual missing-grant admission/create GREEN and affected principal consumers, including absent/forged/expired/native/source failures, known-dormant control, zero new reservation/model/effect on refusal. Freeze, verify receipts, root-commit and normally integrate the three tests.
5. Finish root's three protection files, refresh canonical ledger, and commit the combined candidate. Rerun the existing committed-source cold bootstrap and directly affected queue/principal/maintenance/self-host consumers, R80 parser compatibility and depth-one source-read boundary. Preserve normal versus shallow skips honestly.
6. Fresh combined auditor `/root/takeover_combined_audit` is already independent GPT-6.1 Sol/max, fork-none. It has no new P0/P1 beyond the open fallback. It reviewed queue/maintenance and helper without finding another blocker; independently verified112 evidence files (`retained-evidence-integrity.json`, SHA `a11dbdb6d850cc5b43d9d6e001a985a1b3f5884130a0189c0b928432bbf68753`). It still needs the frozen exact combined candidate and causal GREEN. Do not claim a final audit yet.
7. After local checks/current review, fast-forward inactive source to development and verify its exact native CI. Record workflow/target/SHA/expected duration/remaining hosted assertion first. Do not install or activate this candidate merely because inactive source CI passes.

## Queue canary and rollout approval boundary

The owner's App permission step is done. The separate async question approving the concrete isolated canary remains **unanswered**. Record: `/workspace/evidence/merge-queue/canary-final-preparation/owner-request.json`. Packet `/workspace/evidence/merge-queue/canary-owner-packet.md`; brief `/workspace/evidence/merge-queue/canary-approval-brief.md`. Root previously verified83 manifest files and six audited scope sections. Packet must refresh current refs/CI before execution.

Requested scope: only AI `queue-canary`, nine fixture PRs (reuse existing matches), first PR must survive real Ubiquity OS processing before remaining fixtures; disabled-first canary-only ruleset; reviewed Sentinel App workflows for queue effects. Owner0x4007 handles fixture/probe work and is assigned tracking164. No production ruleset approval is implied. Actual fixture/ruleset/grant IDs are still absent.

Canary includes three successful queue merges, canceled group, App dequeue with deadline/minimum-wait behavior, foreign-entry refusal, head update, rule removal, expected direct-merge405 without fallback, and missing-trigger restoration. Preserve reviewed App check identities and exact grants. Optional extra/bypass/drift scenarios need separate approval. Never close test PRs/delete branches as cleanup.

Before canary dispatch, actual IDs/grants must be encoded in reviewed S, fast-forward development, exact CI/audit/R81 compatibility, then fast-forward sentinel-supervisor to the same S. Keep R81 installed, production queue off, proof false, future pins empty and release disabled. Any S2 dequeue continuation needs the same acceptance before its deadline.

Production ruleset is a later owner step. Critical rollout requirement: queue activation requires both the queue proof floor and independent existing-PR custody floor; new takeover admission can stay false. Runtime **F itself must contain accepted compiled queue proof/policy before it is frozen**, then launcher L pins exact F through authenticated data. Only changing L JSON would leave R's child queue policy inactive. Bootstrap health alone does not prove child queue readiness. Later enqueue-enabled A likewise needs its own compiled ceiling/pins. Refresh the owner packet accordingly before production approval. Never enable AI production rules before Sentinel can enqueue; direct merge then returns405.

Twenty-seven historical direct-PUT merge outcomes remain ambiguous/charged; do not replay or refund. R80 parsing is retained, but R80/R81 execution is forbidden after future custody activation; preserve the independent execution/fallback fence.

## Tools, validation and hard rules

- Environment `/workspace`, Bash, unrestricted. Do not supply `sandbox_permissions`. Deno2.9.7 `/workspace/toolchain/deno/deno`; trusted tools `/workspace/toolchain/system-bin`. Node24.19.0 SHA `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`.
- Root validator `/workspace/evidence/existing-pr-root-wiring/validate.py`: first argument evidence name, then Deno args (or git/node/setup). It binds full source+527 dependency files+Node before/after, scrubbed env, workspace HOME/TMP, network/PID isolation, bounded teardown. Use a fresh evidence name. Example: `timeout 295 python3 .../validate.py NAME test --frozen --cached-only --allow-read=.,/usr,/bin,/usr/local/bin/deno --allow-run --allow-write --allow-env=PATH,NODE_V8_COVERAGE tests/host/EXACT_test.ts`.
- Local commands must be bounded at300s. Tests must not read/chdir under host `/tmp`; retain declared permissions. Observe checks within30s, diagnose silence/failures, no blind whole-suite reruns. Final committed cold source must really include new source. Keep locked action dependencies intact; if absent restore verified527 files or locked npm ci, not permissive skips.
- Root alone owns ledger, commits, integration and publication. Workers return frozen scoped files/evidence. Never merge a worker HEAD while its checks are running.
- Never invoke hosted Codex GitHub app or post `@codex review`. Never edit `src/github/codex-review-rubric.ts`.
- No new Sentinel rulesets/protection. Existing release-state rule23197448 is untouched. No code closing target PRs/deleting branches. No force push; development and sentinel-supervisor fast-forward only. Keep sentinel-release disabled.
- Credentials, state writes, admission and promotion stay outside model workers. No manual authoritative state rewriting. Charges remain; ambiguous outcomes never refund.
- CI first, then current-head review, then merge. Only P0/P1 block; hard three review rounds and three CI fixes. When rounds spent and no P0/P1, merge and file P2/P3 follow-ups.
- Never print credentials or raw native logs. Native log fetch output is processed/hash-checked in memory and sanitized. Connected GitHub and shell reads currently work. Desktop PR attach tool hung again; its pending call was terminated before a following planned ledger edit executed. No ledger edit from that call occurred; no attachment success is claimed.

Owner cleanup to surface, not execute: delete unused stale SENTINEL_MODEL_ID variable; close superseded AI PRs1057/1060/1116; answer isolated canary approval and later production ruleset approval. App permission is already complete.

The original goal is not fully complete: R81 and prerequisites are shipped, but all outstanding repository issues are not yet repaired, takeover is not installed, and merge queue is not activated. Resume the concrete steps above without duplicating existing PRs or reopening completed prerequisites.
