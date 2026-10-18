/goal Keep Sentinel (ubiquity/sentinel) stable in GitHub Actions while it repairs all outstanding issues in ubiquity/sentinel and ubiquity/ai.ubq.fi. Resume the paused work on this new machine. Generation81 and the ai.ubq.fi prerequisite PRs are already shipped; finish existing-PR takeover and the guarded merge-queue rollout without breaking the live pipeline.

START HERE

- Clone the `handoff/sentinel-migration-2026-10-18-1216` branch from ubiquity/sentinel with full history. Read `handoff/2026-10-18-1216/README.md`, then `SESSION-HANDOFF.md`, and restore all seven paused files using `restore-map.json` onto exact base `80e7a3dcede4eea1c9325ba4338098f986b8336e` in a new continuation worktree.
- This branch transports accepted ancestry and unaccepted snapshots; it is not an installed or release-ready runtime. Read repository instructions and reconcile docs/build-status.md before writes. Old machine paths, agents and pending questions are historical, not available capabilities.
- Reverify live refs and health. Last observed runtime: R81 `da98f5f49c45b57cfa97a45fe647c36b1021f302`, gen81. Launcher/sentinel-supervisor: `00b6649eeff51a9754bf3748f793137db9bf8605`. Development: `12bc367852188aa94132b7658d774ec413295c1d`. CI39124867746 for that fixture correction was still running. Keep sentinel-release disabled.

FIRST FINISH THE INTERRUPTED WORK

1. Close the confirmed P1 where missing App principal proof lets an unmarked issue with an existing PR reserve replacement work. The source-only restrictive routing helper is committed; actual host wiring and connected tests are restored but unaccepted. Prove the actual prepareImplementationStart path creates no new reservation/model session/PR or mutation when required App authority is absent. Keep discovery restrictive without granting effects. Preserve every existing charge and refusal assertion.
2. Finish authority-path protections and the combined integration. Obtain a fresh independent GPT-6.1 Sol/max exact-candidate audit, run focused affected checks, the final committed-source cold bootstrap, R80 parser compatibility and a depth-one source-read check. Preserve accepted ancestry, honest shallow skips and unchanged persisted/stdout contracts. Publish inactive source by fast-forward to development only after local acceptance; verify exact native CI. Do not install merely because source CI passes.
3. Continue merge queue issue164 with the included canary plans. Use non-expiring `{reason:"backoff",until:null}` holds; queue custody runs first in every pass; the old direct-merge verifier must never book queue merges. Preserve read-only maintenance verification and the independent old-runtime execution fence.

OWNERSHIP AND APPROVAL

- Always take over an already-open PR when a task references one; do not create a replacement. Runtime effects must authenticate as ubiquity-sentinel[bot]. For manual work, assign the authenticated human to the source issue before PR work, because Ubiquity OS otherwise closes it. Last manual identity0x4007 was assigned sentinel#164.
- Runtime App4682172 / installation155687488 already has accepted Merge queues: Read and write permission. Do not ask again for that completed step.
- Isolated queue-canary approval is still unanswered. Ask the owner using the included concrete packet if no explicit approval transfers with this goal. Production ruleset activation is a separate later owner step. Never enable AI production queue rules until Sentinel can enqueue; direct merges then return405.
- Future runtime F must contain its own accepted compiled queue proof/policy before launcher L pins its exact SHA. Both queue and existing-PR custody floors are required; new takeover admission can remain false. Refresh historical canary/rollout plans and verify exact R/L configuration before activation.

HARD RULES

- No hosted Codex GitHub app or `@codex review`. No new Sentinel rulesets/branch protection. No code closing target PRs or deleting branches. No force pushes; development and sentinel-supervisor fast-forward only. Keep sentinel-release disabled; never edit src/github/codex-review-rubric.ts.
- CI first, then current-head review, then merge. Only P0/P1 block. Hard cap three review rounds and three CI fixes. With rounds spent and no P0/P1 left, merge and file P2/P3 follow-up issues.
- Credentials, authoritative state writes, live admission and promotion stay out of model workers. No manual state rewriting. Reservations stay charged; ambiguous outcomes never refund.
- Preserve R80-parseable state/plan/cell/receipt/stdout shapes and guarded historical source reads. After future custody activation, enforce the reviewed fence against R80/R81 execution/fallback.
- Bound local commands at300s; tests must not read/chdir under host /tmp. Preserve `--allow-read=.,/usr,/bin,<deno> --allow-run --allow-write --allow-env=PATH,NODE_V8_COVERAGE`. Use scoped meaningful checks; do not repeat missing or failed evidence as success. Never paste secrets or raw native logs.
- Preserve the workflow model expression `${{ vars.SENTINEL_IMPLEMENTATION_MODEL_ID || 'gpt-6.1-sol' }}` and the owner's separate existing override. Do not change model routing as part of migration.

OWNER CLEANUP TO SURFACE

- Delete the unused stale SENTINEL_MODEL_ID repository variable.
- Close superseded ai.ubq.fi PRs1057,1060,1116.
- Approve the isolated canary and, later, the separate production ruleset step.

Do not redo merged PRs1159,1180,1207,160,165 or reopen completed generation81 integration issue163. Continue remaining issues and rollout from the recorded state. Local source, review, native CI, installed health and actual issue delivery are separate acceptance claims.
