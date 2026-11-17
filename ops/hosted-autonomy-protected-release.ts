/**
 * The owner's one-time release of the protected-path parks (owner directives
 * 2026-11-17, "dude give sentinel full access please this is unnecessarily
 * nerfed", then "dude so confusing just make sentinel close out all my
 * issues"; docs/DECISIONS.md, 2026-11-17).
 *
 * Eleven records were parked "candidate touches a protected path" under the
 * old rule, which never published such a candidate. Each holds
 * `candidateState.preserved: null`: the protected candidate survives only in
 * an expired artifact, so nothing can be published without a new charged run.
 * The 2026-11-17 policy publishes what the old rule parked (credential paths
 * and an untrusted issue's `.github/` change still park), so each exact park
 * (`OWNER_PROTECTED_RELEASES_2026_11_17`: record id, repository, blocker kind,
 * message and `since`) is released once, through the retry pass's one CAS
 * write, as the same uncharged work plan the owner's `sentinel:retry` label
 * writes (`hosted-autonomy-protected-readmission.ts`), with no label:
 *
 * - `unpublished` (no pull request, no published head): the protected head is
 *   dropped exactly as the label exit drops it (base and branch kept, no head,
 *   checkpoint or candidate state). The runtime takes the record as a fresh
 *   start, refreshes its base itself and charges one implementation start.
 *   A base review receipt and its round stay, as the runtime itself returns a
 *   "work needed" base review to `work` (`loop-base-satisfaction.ts`).
 * - `published_pull` (an open pull request whose published head the parked
 *   correction would have replaced): only the unpublished correction head is
 *   dropped, and the record returns to its own published head, the
 *   existing-published-head continuation (`existingHeadContinuationShape`).
 *   Released only while its pull request is open, unmerged, App-authored, on
 *   the scope's base branch and at exactly that published head; otherwise it
 *   stays parked (and released later, once, if those facts hold). The runtime
 *   re-proves that exact head before anything is charged; its next charge is
 *   that head's CI fix or its review round.
 *
 * Every charge, counter, memory row, reservation, the evidence, the base and
 * the branch stay; nothing is refunded and nothing is charged here. The
 * released record holds no blocker and any later park carries a later
 * `since`, so an entry can never match again: at most once, no new field.
 *
 * Ordering: a release re-run under a runtime without the 2026-11-17 policy
 * parks again on the old rule and wastes its charge. The launcher need not
 * be the installed runtime (install in flight, rollback, separate pointers),
 * so a release takes effect only while the release state names the installed
 * runtime, no installation is in flight, and that revision's OWN source,
 * read whole from the Sentinel repository at exactly that commit, carries the
 * policy (`runtimeSourceCarriesPublicationPolicy`). Anything unproven releases
 * nothing, with a fixed reason. A test pins the facts on this checkout.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { HOSTED_RUNTIME_ID } from "../src/contracts/hosted-supervisor.ts";
import { installationTerminal } from "../src/contracts/hosted-supervisor-installation.ts";
import {
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { hasTakeoverCustody } from "../src/github/existing-pr-takeover-provenance.ts";
import { candidateBranch } from "../src/repair/keys.ts";
import {
  OWNER_PROTECTED_RELEASES_2026_11_17,
  ownerReleased,
  type OwnerReleaseV1,
} from "./hosted-autonomy-owner-releases.ts";
import {
  HOSTED_AUTONOMY_SELF_SCOPE,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  hostedIssueKey,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import { PROTECTED_PATH_BLOCKER } from "./hosted-autonomy-protected-readmission.ts";
import type { RetryPlanV1 } from "./hosted-autonomy-retries.ts";
import type { HostedAutonomyScopeV1 } from "./hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyPullV1,
} from "./hosted-autonomy-types.ts";

/** Detail of the work plan a released protected park returns with. */
export const PROTECTED_RELEASE_DETAIL = "other:protected_path:owner_release";

/** The installed source files the runtime gate reads. */
export const PUBLICATION_POLICY_SOURCES = Object.freeze(
  {
    policy: "src/repair/owner-landing.ts",
    park: "src/repair/loop-implementation-result.ts",
    trust: "src/repair/workflow-trust.ts",
    push: "src/repair/loop-publication.ts",
  } as const,
);

export type PublicationPolicySourcesV1 = Record<
  keyof typeof PUBLICATION_POLICY_SOURCES,
  string
>;

/** Only a credential path is never published (the old rule: any CI path). */
const UNPUBLISHABLE_IS_CREDENTIAL =
  /^export function unpublishablePath\(path: string\): boolean \{\s*return credentialPath\(path\);\s*\}$/m;

/** The launcher's merge-time predicate the policy shares. */
const NEVER_MERGES =
  /^export function sentinelNeverMerges\([^)]*\): boolean \{\s*return ownerLandingTouch\(config, changedPaths, repository\)\.kind !== "none";\s*\}$/m;

/** The park decision: unpublishable, or a CI change on an untrusted issue. */
const PARK_DECISION =
  /^\s*const protectedHit = touch\.kind === "unpublishable" \|\| trust !== "trusted";$/m;

/** The trust read the park decision takes for the candidate's paths. */
const TRUST_READ =
  /\bawait workflowChangeTrust\(deps, record, candidate!\.changedPaths\)/;

/** The App's own issues (capability, base repair) steer a CI change. */
const APP_TRUSTED =
  /^\s*if \(read\.value\.author === BASE_REPAIR_AUTHOR\) return "trusted";$/m;

/** A push GitHub refuses for the `workflows` permission parks, uncharged. */
const PERMISSION_PARK =
  /^\s*if \(push\.error\.detail === PUSH_WORKFLOWS_PERMISSION_DETAIL\) \{$/m;

/**
 * Whether installed source text carries the 2026-11-17 publication policy:
 * only a credential path is unpublishable and the merge-time predicate is
 * the same touch (`policy`), the park is decided by that touch and the trust
 * read (`park`), the App's own issue is trusted (`trust`), and a refused
 * workflow push parks instead of retrying (`push`). A runtime from before the
 * policy, or one that reverted any part of it, fails.
 */
export function runtimeSourceCarriesPublicationPolicy(
  sources: PublicationPolicySourcesV1,
): boolean {
  return UNPUBLISHABLE_IS_CREDENTIAL.test(sources.policy) &&
    NEVER_MERGES.test(sources.policy) &&
    PARK_DECISION.test(sources.park) && TRUST_READ.test(sources.park) &&
    APP_TRUSTED.test(sources.trust) && PERMISSION_PARK.test(sources.push);
}

/**
 * Why the installed runtime holds the release, as the action suffix, or null
 * when it carries the policy: `runtime_unreadable` (release state, runtime
 * pointer or a source file unreadable), `runtime_installing` (an
 * installation in flight could still roll the pointer back) or
 * `runtime_without_policy`.
 */
export async function publicationPolicyRuntimeHold(
  release: ReleaseStateSnapshotV1 | null,
  githubFor: HostedAutonomyDepsV1["githubFor"],
): Promise<string | null> {
  const runtime = release?.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  if (release === null || runtime === undefined) return "runtime_unreadable";
  if (
    (release.hostedInstallations ?? []).some((row) =>
      !installationTerminal(row)
    )
  ) {
    return "runtime_installing";
  }
  const sources: Partial<PublicationPolicySourcesV1> = {};
  try {
    const self = githubFor(HOSTED_AUTONOMY_SELF_SCOPE);
    if (self?.readFileAt === undefined) return "runtime_unreadable";
    for (
      const [key, path] of Object.entries(PUBLICATION_POLICY_SOURCES) as [
        keyof PublicationPolicySourcesV1,
        string,
      ][]
    ) {
      const text = await self.readFileAt(path, runtime.activeRevision);
      if (typeof text !== "string") return "runtime_unreadable";
      sources[key] = text;
    }
  } catch {
    return "runtime_unreadable";
  }
  return runtimeSourceCarriesPublicationPolicy(
      sources as PublicationPolicySourcesV1,
    )
    ? null
    : "runtime_without_policy";
}

/** How a released park returns (module header). */
export type ProtectedReleaseShapeV1 = "unpublished" | "published_pull";

/** One released park, applied in the retry pass's one write. */
export interface ProtectedReleaseV1 {
  id: string;
  repository: RepositoryIdentityV1;
  issueNumber: number;
  shape: ProtectedReleaseShapeV1;
}

/** The shape of a protected park a release can return, or null. */
export function protectedReleaseShape(
  record: WorkRecordV1,
): ProtectedReleaseShapeV1 | null {
  const { target } = record;
  const issueNumber = record.related.issueNumber;
  const state = target.candidateState;
  if (
    record.nextStep !== "blocked" || record.blocker?.kind !== "other" ||
    record.blocker.message !== PROTECTED_PATH_BLOCKER ||
    record.intent !== null || record.wait !== null ||
    record.source.kind !== "issue" || issueNumber === null ||
    record.source.id !== String(issueNumber) ||
    target.checkpoint !== null || target.head === null ||
    target.branch !== candidateBranch(record.id) ||
    state === undefined || state.preserved !== null ||
    target.selfMerge !== undefined || record.ownerLanding !== undefined ||
    hasTakeoverCustody(record)
  ) return null;
  if (target.pr === null && state.publishedHead === null) {
    return "unpublished";
  }
  return target.pr !== null && state.publishedHead !== null &&
      state.publishedHead !== target.head &&
      state.publishedHead !== target.base
    ? "published_pull"
    : null;
}

/**
 * Pure local gate: a record holding exactly one released park, in a shape a
 * release can return, whose source issue is not known closed. `skip` names
 * records another rule of this pass owns. An unusable clock plans nothing.
 */
export function planProtectedReleases(
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string>,
  skip: (id: string) => boolean,
  now: number,
  releases: readonly OwnerReleaseV1[] = OWNER_PROTECTED_RELEASES_2026_11_17,
): ProtectedReleaseV1[] {
  if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) return [];
  const planned: ProtectedReleaseV1[] = [];
  for (const record of snapshot.work) {
    if (skip(record.id) || !ownerReleased(record, releases)) continue;
    const shape = protectedReleaseShape(record);
    const issueNumber = record.related.issueNumber;
    if (
      shape === null || issueNumber === null ||
      closedIssues.has(hostedIssueKey(record.repository, issueNumber))
    ) continue;
    planned.push({
      id: record.id,
      repository: record.repository,
      issueNumber,
      shape,
    });
  }
  return planned;
}

/** The pull request still binds the record's own published head. */
function pullBindsPublishedHead(
  record: WorkRecordV1,
  scope: HostedAutonomyScopeV1,
  pull: HostedAutonomyPullV1 | null,
): boolean {
  return pull !== null && scope.baseBranch !== null &&
    pull.number === record.target.pr && pull.state === "open" &&
    pull.merged === false &&
    pull.headSha === record.target.candidateState?.publishedHead &&
    pull.baseRef === scope.baseBranch &&
    HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author ?? "");
}

/**
 * The planned releases that take effect this pass: each `published_pull`
 * release whose pull request still binds its published head (read first, so
 * a pull that never verifies costs no source read), then all of them only
 * while the installed runtime carries the policy. Reads only when something
 * is planned.
 */
export async function takeProtectedReleases(
  snapshot: RepairStateSnapshotV1,
  planned: readonly ProtectedReleaseV1[],
  release: ReleaseStateSnapshotV1 | null,
  githubFor: HostedAutonomyDepsV1["githubFor"],
  scopeFor: (
    repository: RepositoryIdentityV1,
  ) => Promise<HostedAutonomyScopeV1>,
  readPull: (
    scope: HostedAutonomyScopeV1,
    number: number,
  ) => Promise<HostedAutonomyPullV1 | null>,
  actions: string[],
): Promise<ProtectedReleaseV1[]> {
  const verified: ProtectedReleaseV1[] = [];
  for (const entry of planned) {
    if (entry.shape === "unpublished") {
      verified.push(entry);
      continue;
    }
    const record = snapshot.work.find((row) =>
      row.id === entry.id && sameRepository(row.repository, entry.repository)
    );
    if (record === undefined || record.target.pr === null) continue;
    const scope = await scopeFor(record.repository);
    const pull = await readPull(scope, record.target.pr);
    if (!pullBindsPublishedHead(record, scope, pull)) {
      actions.push(`retry:${entry.id}:skipped:owner_release_pull_unverified`);
      continue;
    }
    verified.push(entry);
  }
  if (verified.length === 0) return [];
  const hold = await publicationPolicyRuntimeHold(release, githubFor);
  if (hold !== null) {
    actions.push(`retry:owner_release:held:${hold}`);
    return [];
  }
  return verified;
}

/** The ordinary uncharged work plan each taken release returns with. */
export function protectedReleasePlan(entry: ProtectedReleaseV1): RetryPlanV1 {
  return {
    id: entry.id,
    repository: entry.repository,
    grant: 0,
    nextStep: "work",
    reviewRounds: null,
    advanceBase: false,
    observedBase: null,
    detail: PROTECTED_RELEASE_DETAIL,
  };
}

/**
 * Drop the parked protected head of every taken release (pure,
 * strict-parsed). `unpublished`: base and branch kept, no head, checkpoint,
 * pull request or candidate state. `published_pull`: the record's own
 * published head returns as its head, candidate state and pull request kept.
 * Every other field and record is unchanged; the work plan
 * (`applyHostedRetries`) moves the step in the same write. A taken release
 * whose record no longer holds its shape throws, so the caller writes nothing.
 */
export function applyProtectedReleases(
  snapshot: RepairStateSnapshotV1,
  taken: readonly ProtectedReleaseV1[],
): RepairStateSnapshotV1 {
  if (taken.length === 0) return snapshot;
  let applied = 0;
  const next = parseRepairStateSnapshotV1({
    ...snapshot,
    work: snapshot.work.map((record) => {
      const entry = taken.find((row) =>
        row.id === record.id &&
        sameRepository(row.repository, record.repository)
      );
      if (entry === undefined) return record;
      if (protectedReleaseShape(record) !== entry.shape) {
        throw new TypeError("protected release lost its park shape");
      }
      applied++;
      const { target } = record;
      return {
        ...record,
        target: entry.shape === "unpublished"
          ? {
            base: target.base,
            branch: target.branch,
            checkpoint: null,
            head: null,
            pr: null,
          }
          : {
            ...target,
            head: target.candidateState!.publishedHead,
            checkpoint: null,
          },
      };
    }),
  });
  if (applied !== taken.length) {
    throw new TypeError("protected release names no parked record");
  }
  return next;
}
