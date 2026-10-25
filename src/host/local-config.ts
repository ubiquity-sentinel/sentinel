import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { HOSTED_AUTHORITY_PROTECTED_PATHS } from "./hosted-authority-protected-paths.ts";
import {
  parseRepositoryConfigV1,
  type RepositoryConfigV1,
} from "../contracts/repository-config.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import {
  DEFAULT_IMPLEMENTATION_MODEL,
  LOCAL_BASE_BRANCH,
  LOCAL_REPOSITORY,
  MAX_MODEL_CHARS,
  STATIC_INVALID_CONTROLLER,
  STATIC_INVALID_OPTIONS,
  STATIC_ORPHAN,
  STATIC_UNSETTLED,
} from "./local-policy.ts";

/** Caller-supplied trusted inputs for one bounded local run. */
export interface LocalRepairHostOptionsV1 {
  stateRoot: string;
  sourceDir: string;
  controllerSha: GitSha;
  githubToken: string;
  modelToken: string;
  codexExecutable: string;
  denoExecutable: string;
  trustedPath: string;
  /**
   * Route-selected implementation model id for this run. Omitted callers keep
   * the frozen gateway default (`gpt-reserve`); the exact configured value is
   * what the implementation port submits and what the status envelope reports.
   */
  modelId?: string;
  /**
   * Dedicated structured-review model id for this run. It is never the
   * implementation model: an absent value falls back to the owner's
   * preferred default (`codex-auto-review`); a malformed value yields the
   * invalid empty sentinel, which the reviewer refuses at prepare before
   * any session opens.
   */
  reviewModelId?: string;
}

/** Outcome of one startup attempt. Busy is an explicit refusal, not a wait. */
export type LocalRepairHostRunV1 =
  | { status: "busy" }
  | { status: "ran"; outcome: RepairCycleOutcomeV1; statusPath: string };

/** A prior marker proves a possible orphaned writer; never reclaimed here. */
export class LocalHostOrphanError extends Error {
  constructor() {
    super(STATIC_ORPHAN);
    this.name = "LocalHostOrphanError";
  }
}

/** Owned sessions did not settle; the marker and lock are retained. */
export class LocalHostSettlementError extends Error {
  constructor() {
    super(STATIC_UNSETTLED);
    this.name = "LocalHostSettlementError";
  }
}

// ---------------------------------------------------------------------------
// Fixed configuration (pure; no I/O)
// ---------------------------------------------------------------------------

/** The one fixed local repository configuration, through the frozen parser. */
export function createLocalRepositoryConfig(): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: { ...LOCAL_REPOSITORY },
    baseBranch: LOCAL_BASE_BRANCH,
    adapter: { kind: "github" },
    commands: { replay: "replay_capture", test: "test_ci" },
    commandRegistry: {
      version: "v1",
      commands: {
        test_ci: {
          executable: "deno",
          args: ["task", "test:local"],
          maxDurationMs: 1_800_000,
          maxOutputBytes: 4_194_304,
        },
        replay_capture: {
          executable: "deno",
          args: ["task", "replay:capture"],
          maxDurationMs: 600_000,
          maxOutputBytes: 1_048_576,
        },
      },
    },
    protectedPaths: [
      ...HOSTED_AUTHORITY_PROTECTED_PATHS,
      "src/repair/model-port-notifications.ts",
      "src/github/reviewer-retention.ts",
      "src/host/review-owner-channel-event.ts",
      "src/repair/codex-json-frame.ts",
      "src/repair/codex-transport.ts",
      "src/repair/model-port-settlement.ts",
      "src/repair/base-satisfaction-marker.ts",
      "src/repair/loop-base-satisfaction.ts",
      "src/github/base-review-comments.ts",
      "src/github/base-review-evidence.ts",
      "src/github/base-review-service.ts",
      "src/github/base-review-owner.ts",
      ".github/workflows/",
      "AGENTS.md",
      "MASTER-PLAN.md",
      "deno.json",
      "ops/code-size.ts",
      // The launcher's credential-expiry re-admission returns terminal
      // base-refresh blocks to work and restores their PR identity
      // (admission) without any charge.
      "ops/hosted-autonomy-base-refresh-retries.ts",
      // The PR facts that re-admission trusts: the head-ref pull listing and
      // its parser (forks, other heads and unprovable full pages refused).
      "ops/hosted-autonomy-github.ts",
      "ops/hosted-autonomy-github-pull.ts",
      "docs/build-status.md",
      // The committed target setting decides which repositories this
      // deployment may repair. A model worker must never be able to add itself
      // a target repository, so the file is protected like every other
      // authority artifact.
      "sentinel.targets.json",
      "src/contracts/github-cooldown.ts",
      "src/contracts/hosted-execution.ts",
      "src/contracts/hosted-supervisor.ts",
      "src/contracts/hosted-supervisor-types.ts",
      "src/contracts/hosted-supervisor-execution.ts",
      "src/contracts/hosted-supervisor-runtime.ts",
      "src/contracts/hosted-supervisor-release.ts",
      "src/contracts/local-release.ts",
      "src/contracts/ports.ts",
      "src/contracts/ports-github-requests.ts",
      "src/contracts/ports-github.ts",
      "src/contracts/ports-evidence.ts",
      "src/contracts/ports-model.ts",
      "src/contracts/ports-release.ts",
      "src/contracts/ports-state.ts",
      "src/contracts/state-snapshots.ts",
      "src/github/client.ts",
      "src/github/client-contracts.ts",
      "src/github/client-http.ts",
      "src/github/client-response.ts",
      "src/github/client-issue-wire.ts",
      "src/github/client-issues.ts",
      "src/github/client-reads.ts",
      "src/github/client-writes.ts",
      "src/github/client-ci-wire.ts",
      "src/github/client-ci.ts",
      "src/github/client-hosted-policy.ts",
      "src/github/client-hosted-revision-wire.ts",
      "src/github/client-hosted-revisions.ts",
      "src/github/client-hosted-job-wire.ts",
      "src/github/client-hosted-log-wire.ts",
      "src/github/client-hosted-execution.ts",
      "src/github/client-review-wire.ts",
      "src/github/http.ts",
      "src/host/actions-ci.ts",
      "src/host/actions-candidates.ts",
      "src/host/actions-candidates-shared.ts",
      "src/host/actions-candidates-restore.ts",
      "src/host/actions-candidates-objects.ts",
      "src/host/actions-candidates-preserve.ts",
      "src/host/actions-candidates-proof.ts",
      "src/host/actions-candidates-legacy-bindings.ts",
      "src/host/actions-candidates-legacy-proof.ts",
      "src/host/actions-candidates-legacy.ts",
      "src/host/actions-preflight.ts",
      "src/host/actions-release.ts",
      "src/host/actions-supervisor.ts",
      "src/host/actions-supervisor-bootstrap.ts",
      "src/host/actions-supervisor-state.ts",
      "src/host/actions-supervisor-source.ts",
      "src/host/actions-supervisor-controller.ts",
      "src/host/actions-supervisor-host.ts",
      "src/host/actions-supervisor-types.ts",
      "src/host/actions.ts",
      "src/host/actions-target-cycles.ts",
      "src/host/actions-repair-host.ts",
      "src/host/actions-host-io.ts",
      "src/contracts/matrix.ts",
      "src/contracts/matrix-identity.ts",
      "src/contracts/matrix-model.ts",
      "src/host/matrix.ts",
      "src/host/matrix-identity.ts",
      "src/host/matrix-planner.ts",
      "src/host/matrix-cell.ts",
      "src/host/matrix-ingest-state.ts",
      "src/host/matrix-ingest.ts",
      "src/host/matrix-git.ts",
      "src/host/matrix-actions.ts",
      "src/host/matrix-quarantine-state.ts",
      "src/host/matrix-quarantine.ts",
      "src/host/matrix-actions-shared.ts",
      "src/host/matrix-native-host.ts",
      "src/host/matrix-aggregate.ts",
      "src/host/matrix-artifact-port.ts",
      "src/host/matrix-artifacts.ts",
      "src/host/matrix-artifact-values.ts",
      "src/host/matrix-artifact-diagnostics.ts",
      "src/host/matrix-artifact-context.ts",
      "src/host/matrix-artifact-http.ts",
      "src/host/matrix-artifact-archive.ts",
      "src/host/matrix-artifact-native.ts",
      "src/host/matrix-artifact-wave.ts",
      "src/host/modern-matrix-recovery.ts",
      "src/host/hosted-cooldown.ts",
      "src/host/hosted-runtime.ts",
      "src/host/hosted-runtime-identity.ts",
      "src/host/hosted-runtime-launcher.ts",
      "src/host/hosted-runtime-diagnostics.ts",
      "src/host/hosted-runtime-status.ts",
      "src/host/hosted-runtime-child.ts",
      "src/host/hosted-runtime-matrix.ts",
      "src/host/hosted-runtime-main.ts",
      "src/host/hosted-runtime-frame-labels.ts",
      "src/host/hosted-app-token-window.ts",
      "src/host/local-release.ts",
      "src/host/local-supervisor.ts",
      "src/host/local.ts",
      "src/host/local-policy.ts",
      "src/host/local-config.ts",
      "src/host/target-policy.ts",
      "src/host/gateway-capabilities.ts",
      "src/host/vps-release.ts",
      "src/host/review-owner-host.ts",
      "src/host/review-owner-custody.ts",
      "src/host/review-owner-channel.ts",
      "src/host/review-owner-child-input.ts",
      "src/host/local-client.ts",
      "src/host/local-checkout.ts",
      "src/host/local-model-reason.ts",
      "src/host/local-model-result.ts",
      "src/host/local-model-diagnostic.ts",
      "src/host/local-github.ts",
      "src/host/local-base-refresh.ts",
      "src/host/local-github-auth.ts",
      "src/host/local-model.ts",
      "src/host/local-git.ts",
      "src/host/local-candidate.ts",
      "src/host/local-review-checkout.ts",
      "src/host/local-status.ts",
      "src/host/local-io.ts",
      "src/host/local-supervisor-shared.ts",
      "src/host/local-supervisor-release.ts",
      "src/host/local-supervisor-requests.ts",
      "src/host/local-supervisor-observation.ts",
      "src/host/local-supervisor-runtime.ts",
      "src/host/local-supervisor-child.ts",
      "src/host/local-supervisor-git.ts",
      "src/main.ts",
      "src/repair/github-cooldown.ts",
      "src/repair/loop.ts",
      "src/repair/loop-types.ts",
      "src/repair/loop-bounds.ts",
      "src/repair/loop-eligibility.ts",
      "src/repair/loop-records.ts",
      "src/repair/loop-state.ts",
      "src/repair/loop-intake.ts",
      "src/repair/loop-legacy-loss.ts",
      "src/repair/loop-cycle.ts",
      "src/repair/loop-post-drain.ts",
      "src/repair/loop-work.ts",
      "src/repair/loop-evidence.ts",
      "src/repair/loop-replay-before.ts",
      "src/repair/loop-replay-evidence.ts",
      "src/repair/loop-replay-validation.ts",
      "src/repair/loop-review-records.ts",
      "src/repair/loop-implementation.ts",
      "src/repair/loop-implementation-result.ts",
      "src/repair/loop-preservation.ts",
      "src/repair/loop-accounting.ts",
      "src/repair/loop-publication.ts",
      "src/repair/loop-publication-state.ts",
      "src/repair/loop-review-request.ts",
      "src/repair/loop-review-observation.ts",
      "src/repair/loop-review-result.ts",
      "src/repair/loop-review-recovery.ts",
      // The hard review-round ceiling (owner decision 2026-10-16) and the
      // runtime parks it decides. A model-authored candidate must never raise
      // or bypass it.
      "src/repair/review-round-cap.ts",
      "src/repair/loop-review-round-cap.ts",
      // The delivery line decides when a reviewed head on a moved base may
      // spend a round on a refreshed head; the ceiling's moved-base park
      // reads the head's CI there first.
      "src/repair/delivery-queue.ts",
      "src/repair/loop-delivery-queue.ts",
      // The carried review (a spent record's mechanically refreshed head
      // merged by the launcher under its earlier review only with a
      // byte-identical patch and green CI), the git patch proof it rests on,
      // and the legacy class's cutoff hand-over. A model-authored candidate
      // must never weaken them.
      "src/repair/carried-review.ts",
      "src/repair/loop-carried-delivery.ts",
      "src/github/git-carried-patch.ts",
      "src/github/port-merge.ts",
      "src/host/legacy-review-cutoff-env.ts",
      "src/repair/loop-checks.ts",
      // CI attribution decides whether a reviewed head is corrected (a charged
      // round), deferred on a red base or blocked; the launcher rule decides
      // its re-admission. A model-authored candidate must never weaken them.
      "src/repair/ci-rejection.ts",
      "src/repair/loop-ci-correction.ts",
      "ops/hosted-autonomy-ci-retries.ts",
      // The CI-first gate (owner decision 2026-10-16): a head is reviewed
      // only once its CI is green, a CI fix is charged and bounded, and the
      // launcher decides when a pre-review park or a legacy final round is
      // re-admitted. A model-authored candidate must never weaken them. The
      // base-repair lane decides which task's red base is its own charged
      // CI fix.
      "src/repair/ci-first-policy.ts",
      "src/repair/loop-ci-first.ts",
      "ops/hosted-autonomy-ci-first.ts",
      "src/repair/base-repair.ts",
      // Spent-round delivery and its review follow-ups: merge admissibility
      // and the latest-review rule, and the App-token issue filing (review
      // follow-ups and base-repair issues). The delivery pass makes every
      // launcher merge, the carried merge included (its gate, the merge-once
      // bound and the bookkeeping), the Git tree read is the carried patch
      // proof and the raw compare read its evidence.
      "ops/hosted-autonomy-delivery-pass.ts",
      "ops/hosted-autonomy-github-trees.ts",
      "ops/hosted-autonomy-github-listing.ts",
      "ops/hosted-autonomy-spent-delivery.ts",
      "ops/hosted-autonomy-github-issues.ts",
      "ops/hosted-autonomy-follow-ups.ts",
      "ops/hosted-autonomy-follow-up-pass.ts",
      "ops/hosted-autonomy-base-repair.ts",
      // The conflict resolution decides when a base-refresh conflict is
      // charged, exactly what the trusted host commits for it (the merge
      // committer and resolver) and when the launcher re-admits a conflict
      // block. A model-authored candidate must never weaken them.
      "src/repair/conflict-resolution.ts",
      "src/repair/loop-conflict-resolution.ts",
      "src/repair/model-port-checkout.ts",
      "ops/hosted-autonomy-conflict-retries.ts",
      // The launcher files that apply that re-admission gate, supply the
      // authenticated runtime record it trusts, and define its blocker prefix
      // and review-round ceiling.
      "ops/hosted-autonomy-retries.ts",
      "ops/hosted-autonomy-retry-pass.ts",
      "ops/hosted-autonomy-policy.ts",
      // The refresh re-arm returns a refused refresh to delivery, where the
      // refreshed head would need a review round; it withholds that at the
      // ceiling.
      "ops/hosted-autonomy-refresh-rearm.ts",
      // The flake re-run: it re-runs a parked head's failed run once and
      // decides when that head's correction may be re-admitted.
      "ops/hosted-autonomy-ci-rerun.ts",
      "src/repair/loop-base-refresh.ts",
      // Bounded base-refresh failure accounting and the terminal block.
      "src/repair/loop-base-refresh-failure.ts",
      "src/repair/loop-merge.ts",
      "src/repair/loop-release.ts",
      "src/repair/loop-closure.ts",
      "src/repair/loop-task-context.ts",
      // Decides provider-throttling settlement and the bounded 429 retry
      // inside one charged admission.
      "src/repair/model-port-retry.ts",
      // Applies the failover window and the bounded retry to one session.
      "src/repair/model-port-session.ts",
      // Decides the route's 429 failover model, which the trusted matrix
      // ingesters (runtime and launcher recovery) accept besides the plan's.
      "src/host/model-route.ts",
      // Decide whether a model result is provider throttling, which class an
      // attempt settles as, and which failover id launcher recovery accepts.
      "src/repair/model-port-policy.ts",
      "src/repair/model-port-diagnostics.ts",
      "src/repair/attempt-policy.ts",
      "ops/hosted-autonomy-matrix-bindings.ts",
      "src/state/",
      "src/budget/",
    ],
    build: { projectId: null, acceptance: null },
    secretRef: "secret://host/injected/sentinel-local-owner",
    // Owner update, 2026-10-02: all artificial throughput caps are lifted.
    // Both rolling caps are explicitly null (uncapped), never a fake huge
    // number; durable reservation accounting and unique admission remain.
    liveStartLimits: { perHour: null, perSevenDays: null },
    // 30 minutes, matching this same template's own `test_ci` command
    // allowance (1_800_000). A 20-minute bound cut three of four ai.ubq.fi
    // sessions off at exactly 1_200_000 ms while a larger codebase's session
    // needs longer; the completion that DID finish used 1_187_000 ms, which is
    // 13 s of headroom and therefore not a real bound but a coin flip. The
    // 110-minute run deadline still fits two such sessions plus the reserved
    // validation and publication margin.
    // Streamed volume never ends a newly planned session. Keep the existing
    // positive safe-integer wire field so R80 can parse plans and receipts;
    // this value cannot be reached during the unchanged 30-minute deadline.
    // The model port retains only bounded evidence, independent of this total.
    sessionBound: {
      maxDurationMs: 1_800_000,
      maxOutputChars: Number.MAX_SAFE_INTEGER,
    },
    retention: null,
    stabilityPolicy: null,
  });
}

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

export function readLocalHostOptions(
  options: LocalRepairHostOptionsV1,
): LocalRepairHostOptionsV1 & { modelId: string; reviewModelId: string } {
  let record: Record<string, unknown>;
  try {
    record = options as unknown as Record<string, unknown>;
  } catch {
    throw new TypeError(STATIC_INVALID_OPTIONS);
  }
  const controllerSha = record?.controllerSha;
  if (!isGitSha(controllerSha)) throw new TypeError(STATIC_INVALID_CONTROLLER);
  return {
    stateRoot: requirePath(record.stateRoot, "stateRoot"),
    sourceDir: requirePath(record.sourceDir, "sourceDir"),
    controllerSha,
    githubToken: requirePath(record.githubToken, "githubToken"),
    modelToken: requirePath(record.modelToken, "modelToken"),
    codexExecutable: requirePath(record.codexExecutable, "codexExecutable"),
    denoExecutable: requirePath(record.denoExecutable, "denoExecutable"),
    trustedPath: requirePath(record.trustedPath, "trustedPath"),
    modelId: requireModelId(record.modelId),
    reviewModelId: requireReviewModelId(record.reviewModelId),
  };
}

/**
 * Route-selected implementation model id. An absent value keeps the frozen
 * gateway default; a present but malformed value is refused outright (it is
 * never silently replaced, so the recorded model always equals the requested
 * one).
 */
function requireModelId(value: unknown): string {
  if (value === undefined) return DEFAULT_IMPLEMENTATION_MODEL;
  if (!isBoundedModelId(value)) throw new TypeError(STATIC_INVALID_OPTIONS);
  return value;
}

/**
 * Dedicated structured-review model id. An absent or malformed value yields
 * the invalid empty sentinel (never the frozen default and never the
 * implementation model): the reviewer refuses at prepare before any session
 * opens.
 */
function requireReviewModelId(value: unknown): string {
  if (!isBoundedModelId(value)) return "";
  return value;
}

/** A bounded model id: nonempty, exactly trimmed, no control characters. */
function isBoundedModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_MODEL_CHARS) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function requirePath(value: unknown, _field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(STATIC_INVALID_OPTIONS);
  }
  return value;
}
