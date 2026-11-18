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
import { portError, portOk } from "../src/contracts/ports.ts";
import { issueAuthorAdmitted } from "../src/repair/issue-admission.ts";
import { recordCiTrust } from "../src/repair/workflow-trust.ts";
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
  HostedAutonomyGitHubV1,
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
    admission: "src/repair/issue-admission.ts",
    start: "src/repair/loop-implementation.ts",
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

/** The park decision: unpublishable, or a CI change on an untrusted source. */
const PARK_DECISION =
  /^\s*const protectedHit = touch\.kind === "unpublishable" \|\| trust === "untrusted";$/m;

/** The trust read the park decision takes for the candidate's paths. */
const TRUST_READ =
  /\bawait workflowChangeTrust\(deps, record, candidate!\.changedPaths\)/;

/**
 * Provenance trust (2026-11-17): the owner's issue is trusted, any other
 * author's is not, and of the App's only the structured kinds Sentinel writes
 * from its own facts (base repair, the capability notice) are.
 */
const OWNER_TRUSTED = /^\s*if \(kind === "owner"\) return "trusted";$/m;
const OTHER_UNTRUSTED = /^\s*if \(kind === "other"\) return "untrusted";$/m;
const STRUCTURED_APP_TRUSTED =
  /^\s*if \(isBaseRepairBody\(issue\.body\) \|\| capabilityNotice\(issue\.body\)\) \{$/m;

/** Admission: only the owner account (login and id) and the App are worked. */
const OWNER_IDENTITY = /\{ login: "0x4007", id: 4975670 \}/;
const ADMITTED = /^\s*return issueAuthorKind\(issue\) !== "other";$/m;
/** A not-admitted record parks, uncharged, at its pre-start issue read. */
const START_PARK = /^\s*if \(observation\.kind === "not_admitted"\) \{$/m;

/** A push GitHub refuses for the `workflows` permission parks, uncharged. */
const PERMISSION_PARK =
  /^\s*if \(push\.error\.detail === PUSH_WORKFLOWS_PERMISSION_DETAIL\) \{$/m;

/**
 * Whether installed source text carries the 2026-11-17 policy as it finally
 * stands: only a credential path is unpublishable and the merge-time
 * predicate is the same touch (`policy`), the park is decided by that touch
 * and an untrusted source (`park`), trust follows provenance (`trust`: the
 * owner's issue, and the App's structured base-repair and capability issues),
 * a refused workflow push parks instead of retrying (`push`), and only the
 * owner's and the App's issues are worked (`admission`), a record of any
 * other author parking uncharged before its start (`start`). A runtime from
 * before the policy, or one that reverted any part of it, fails.
 */
export function runtimeSourceCarriesPublicationPolicy(
  sources: PublicationPolicySourcesV1,
): boolean {
  return UNPUBLISHABLE_IS_CREDENTIAL.test(sources.policy) &&
    NEVER_MERGES.test(sources.policy) &&
    PARK_DECISION.test(sources.park) && TRUST_READ.test(sources.park) &&
    OWNER_TRUSTED.test(sources.trust) &&
    OTHER_UNTRUSTED.test(sources.trust) &&
    STRUCTURED_APP_TRUSTED.test(sources.trust) &&
    PERMISSION_PARK.test(sources.push) &&
    OWNER_IDENTITY.test(sources.admission) &&
    ADMITTED.test(sources.admission) && START_PARK.test(sources.start);
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
/** Why a release's source issue is not established; null when it is. */
export type ReleaseSourceRefusalV1 =
  | "owner_release_source_unreadable"
  | "owner_release_not_admitted"
  | "owner_release_untrusted";

/**
 * Whether the released record's source issue is still worked and, on a
 * target, may steer a `.github/` change, read live over the record's own
 * repository surface with the runtime's exact rules (`issue-admission.ts`,
 * `recordCiTrust`): its author is the owner account (login and id) or the
 * App, and on a target its provenance is trusted (the owner's issue, or the
 * App's base-repair or capability issue; a review follow-up by its origin).
 * The parked candidates are gone, so whether a target's fix needs `.github/`
 * is unknown: every target release needs trust. On Sentinel's own repository
 * trust is never consulted (its `.github/` never publishes; an authority
 * change lands for the owner). Anything unreadable is not established: the
 * release skips, uncharged, instead of spending a run that would park.
 */
export async function releaseSourceRefusal(
  record: WorkRecordV1,
  surface: HostedAutonomyGitHubV1 | null,
): Promise<ReleaseSourceRefusalV1 | null> {
  const number = record.related.issueNumber;
  const read = surface?.readIssueFacts;
  if (number === null || surface === null || read === undefined) {
    return "owner_release_source_unreadable";
  }
  const github = {
    async readIssue(issue: number) {
      try {
        const facts = await read.call(surface, issue);
        return facts === null
          ? portError("unavailable", "issue unreadable")
          : portOk(facts);
      } catch {
        return portError("unavailable", "issue unreadable");
      }
    },
  };
  const first = await github.readIssue(number);
  if (!first.ok || first.value.number !== number) {
    return "owner_release_source_unreadable";
  }
  if (!issueAuthorAdmitted(first.value)) return "owner_release_not_admitted";
  if (sameRepository(record.repository, HOSTED_AUTONOMY_SELF_SCOPE)) {
    return null;
  }
  const trust = await recordCiTrust(
    { github } as unknown as Parameters<typeof recordCiTrust>[0],
    record,
  );
  return trust === "trusted"
    ? null
    : trust === "untrusted"
    ? "owner_release_untrusted"
    : "owner_release_source_unreadable";
}

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
    const record = snapshot.work.find((row) =>
      row.id === entry.id && sameRepository(row.repository, entry.repository)
    );
    if (record === undefined) continue;
    const scope = await scopeFor(record.repository);
    if (entry.shape === "published_pull") {
      if (record.target.pr === null) continue;
      const pull = await readPull(scope, record.target.pr);
      if (!pullBindsPublishedHead(record, scope, pull)) {
        actions.push(
          `retry:${entry.id}:skipped:owner_release_pull_unverified`,
        );
        continue;
      }
    }
    // 2026-11-17 admission and provenance trust, read live: a record that
    // would only park again is never released (uncharged skip).
    const refusal = await releaseSourceRefusal(record, scope.surface);
    if (refusal !== null) {
      actions.push(`retry:${entry.id}:skipped:${refusal}`);
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
