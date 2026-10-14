/**
 * Concrete authenticated GitHub build receipt resolver (m05).
 *
 * Implements BuildReceiptResolverV1 against the fixed GitHub REST origin
 * `https://api.github.com`. The exact accepted merged PR binds the request
 * revision, the trusted workflow blob is pinned at that revision, exactly one
 * terminal push run for the request workflow/branch/revision is selected
 * (never by time or list order), the exact attempt's receipt artifact is
 * downloaded through the authenticated 302 plus credential-free signed
 * storage flow with exact size/digest verification, the archive is decoded by
 * the bounded receipt-archive reader and validated against the strict
 * producer schema, and the run attempt is re-read before the receipt is
 * returned.
 *
 * Hard rules of this module:
 * - Multiple matching runs or artifacts are ambiguous, never selected by
 *   order or time; an empty listing is absent; a failure is never a
 *   successful empty result.
 * - All API requests are GETs that target only the fixed API origin; the
 *   artifact 302 Location is followed exactly once with no credentials and
 *   no redirects, and only after rejecting non-HTTPS, userinfo, fragments,
 *   IP-literal and localhost hosts.
 * - No raw URL, body, header, token or exception is ever returned: every
 *   failure is a static typed PortResultV1 error.
 * - One whole-resolve deadline (default 30s, constructor `timeoutMs`
 *   1..30000 for deterministic tests) spans auth, all reads, the body and
 *   ZIP decoding; uncooperative promises are raced and late responses and
 *   readers are cancelled, timers are cleared.
 * - The resolver writes no state and promotes nothing.
 */

import type { GitSha } from "../contracts/brands.ts";
import {
  type Clock,
  portError,
  type PortErrorKindV1,
  portOk,
  type PortResultV1,
} from "../contracts/ports.ts";
import {
  parseReleaseRequestV1,
  type ReleaseRequestV1,
  type ReleaseTargetEnvironmentV1,
} from "../contracts/release.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type {
  BuildReceiptLookupV1,
  BuildReceiptResolverV1,
} from "./resolver.ts";
import { decodeBuildReceiptArchive } from "./receipt-archive.ts";
import * as cfg from "./build-receipt-config.ts";
import type {
  GithubBuildReceiptResolverAuthV1,
  GithubBuildReceiptResolverOptionsV1,
} from "./build-receipt-config.ts";
import {
  DEADLINE,
  DeadlineTracker,
  GithubApi,
  guardUntil,
  mapHttpStatus,
  paginate,
  readBoundedBytes,
} from "./build-receipt-transport.ts";
import * as proof from "./build-receipt-verification.ts";
export type {
  GithubBuildReceiptResolverAuthV1,
  GithubBuildReceiptResolverOptionsV1,
} from "./build-receipt-config.ts";

/**
 * Concrete authenticated resolver for one configured repository/project.
 * The trusted host injects repository, project, base branch, the pinned
 * workflow blob SHA, clock, auth capability, fetch and optional timeout; this
 * construction is a local capability, not an approved deployment policy.
 */
export class GithubBuildReceiptResolver implements BuildReceiptResolverV1 {
  private readonly repository: RepositoryIdentityV1;
  private readonly environment: ReleaseTargetEnvironmentV1;
  private readonly project: string;
  private readonly baseBranch: string;
  private readonly workflowBlobSha: GitSha;
  private readonly clock: Clock;
  private readonly auth: GithubBuildReceiptResolverAuthV1;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly configError:
    | { kind: PortErrorKindV1; detail: string }
    | null;

  constructor(options: GithubBuildReceiptResolverOptionsV1) {
    const config = cfg.validateConfig(options);
    if (config === null) {
      this.repository = {
        owner: "",
        name: "",
        installationId: 0,
      };
      this.environment = "production";
      this.project = "";
      this.baseBranch = "";
      this.workflowBlobSha = "" as GitSha;
      this.clock = { now: () => 0 };
      this.auth = {
        authorizationHeader: () =>
          Promise.resolve(portError("unavailable", "unavailable")),
      };
      this.fetchImpl = globalThis.fetch;
      this.timeoutMs = cfg.DEFAULT_TIMEOUT_MS;
      this.configError = { kind: "invalid", detail: cfg.ERR_CONFIG };
      return;
    }
    this.repository = config.repository;
    this.environment = config.environment;
    this.project = config.project;
    this.baseBranch = config.baseBranch;
    this.workflowBlobSha = config.workflowBlobSha;
    this.clock = config.clock;
    this.auth = config.auth;
    this.fetchImpl = config.fetchImpl;
    this.timeoutMs = config.timeoutMs;
    this.configError = null;
  }

  async resolve(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<BuildReceiptLookupV1>> {
    if (this.configError !== null) {
      return portError(this.configError.kind, this.configError.detail);
    }
    let parsed: ReleaseRequestV1;
    try {
      parsed = parseReleaseRequestV1(request);
    } catch {
      return portError("invalid", cfg.ERR_REQUEST);
    }
    if (
      parsed.target.repository.owner !== this.repository.owner ||
      parsed.target.repository.name !== this.repository.name ||
      parsed.target.repository.installationId !==
        this.repository.installationId
    ) {
      return portError("invalid", cfg.ERR_REQUEST_REPOSITORY);
    }
    if (parsed.target.environment !== this.environment) {
      return portError("invalid", cfg.ERR_REQUEST_ENVIRONMENT);
    }

    const repoFull = `${this.repository.owner}/${this.repository.name}`;
    const owner = this.repository.owner;
    const name = this.repository.name;
    const revision = parsed.revision;
    const baseBranch = this.baseBranch;
    const workflowRef =
      `${repoFull}/${cfg.WORKFLOW_PATH}@refs/heads/${baseBranch}`;

    const tracker = new DeadlineTracker(this.timeoutMs);

    // One clock reading used for every expiry comparison; it must be a finite
    // valid epoch, otherwise expiry checks are meaningless.
    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      return portError("invalid", cfg.ERR_CONFIG);
    }

    // Auth is fetched once, inside the whole-resolve deadline; the value is
    // scoped to this resolve and never stored or returned. A synchronous
    // throw or an async rejection is a static typed auth error, never an
    // escaped rejection of resolve.
    const authPromise: Promise<PortResultV1<string>> = Promise.resolve()
      .then(() => this.auth.authorizationHeader())
      .catch(() =>
        portError("auth_failed", cfg.ERR_AUTH) as PortResultV1<string>
      );
    const authResult = await guardUntil(authPromise, tracker.remainingMs());
    if (authResult === DEADLINE) {
      return portError("unavailable", cfg.ERR_TIMEOUT);
    }
    if (!authResult.ok || authResult.value.length === 0) {
      return portError("auth_failed", cfg.ERR_AUTH);
    }
    const authorization = authResult.value;

    const api = new GithubApi(this.fetchImpl, tracker, authorization);
    try {
      // --- Step 1: exact merged PR binding -------------------------------
      const prResult = await api.getJson(
        `/repos/${owner}/${name}/pulls/${parsed.source.pullRequest}`,
      );
      if (!prResult.ok) return prResult;
      const prIdentity = proof.validatePrPayload(prResult.value, {
        pullRequest: parsed.source.pullRequest,
        revision,
        head: parsed.source.head,
        baseBranch,
        repoFull,
      });
      if (prIdentity === null) return portError("invalid", cfg.ERR_PR);
      const repoId = prIdentity.repoId;

      // --- Step 2: pinned workflow blob at the request revision ----------
      const contentsResult = await api.getJson(
        `/repos/${owner}/${name}/contents/${cfg.WORKFLOW_PATH}`,
        { ref: revision },
      );
      if (!contentsResult.ok) return contentsResult;
      let contentsData: { type: string; path: string; sha: string };
      try {
        const contents = cfg.asRecord(contentsResult.value);
        const type = cfg.asString(cfg.field(contents, "type"));
        const path = cfg.asString(cfg.field(contents, "path"));
        const sha = cfg.asString(cfg.field(contents, "sha"));
        contentsData = { type, path, sha };
      } catch {
        return portError("invalid", cfg.ERR_PAYLOAD);
      }
      if (
        contentsData.type !== "file" ||
        contentsData.path !== cfg.WORKFLOW_PATH ||
        contentsData.sha !== this.workflowBlobSha
      ) {
        return portError("invalid", cfg.ERR_PAYLOAD);
      }

      // --- Step 3: workflow id and exactly one terminal push run ---------
      const workflowResult = await api.getJson(
        `/repos/${owner}/${name}/actions/workflows/${cfg.WORKFLOW_FILENAME}`,
      );
      if (!workflowResult.ok) return workflowResult;
      let workflowId: number;
      try {
        workflowId = proof.validateWorkflowPayload(workflowResult.value, {
          workflowId: null,
        });
      } catch {
        return portError("invalid", cfg.ERR_WORKFLOW);
      }

      const runsPages = await paginate(
        api,
        `/repos/${owner}/${name}/actions/workflows/${workflowId}/runs`,
        { head_sha: revision, event: "push", branch: baseBranch },
        "workflow_runs",
        cfg.ERR_RUNS_PAGINATION,
      );
      if (!runsPages.ok) return runsPages;
      const runs: { id: number; attempt: number; terminal: boolean }[] = [];
      const seenRunIds = new Set<number>();
      for (const item of runsPages.value.items) {
        let validated: { id: number; attempt: number; terminal: boolean };
        try {
          validated = proof.validateRunListItem(item, {
            revision,
            baseBranch,
            repoFull,
            workflowId,
            repoId,
          });
        } catch {
          return portError("invalid", cfg.ERR_RUNS);
        }
        if (seenRunIds.has(validated.id)) {
          return portError("invalid", cfg.ERR_RUNS);
        }
        seenRunIds.add(validated.id);
        runs.push(validated);
      }
      const runSelection = ((): proof.RunSelection => {
        if (runs.length === 0) return { status: "absent" };
        if (runs.length > 1) return { status: "ambiguous" };
        const only = runs[0];
        if (!only.terminal) return { status: "absent" };
        return {
          status: "run",
          run: { id: only.id, attempt: only.attempt },
        };
      })();
      if (runSelection.status === "absent") {
        return portOk<BuildReceiptLookupV1>({ status: "absent" });
      }
      if (runSelection.status === "ambiguous") {
        return portOk<BuildReceiptLookupV1>({
          status: "ambiguous",
          detail: "multiple matching workflow runs",
        });
      }
      const run = runSelection.run;
      const runId = run.id;
      const attempt = run.attempt;

      // --- Step 4: exact attempt + receipt artifact -----------------------
      const attemptResult = await api.getJson(
        `/repos/${owner}/${name}/actions/runs/${runId}/attempts/${attempt}`,
      );
      if (!attemptResult.ok) return attemptResult;
      let conclusion: "success" | "failure";
      try {
        conclusion = proof.validateAttemptPayload(attemptResult.value, {
          runId,
          attempt,
          revision,
          baseBranch,
          repoFull,
          workflowId,
          repoId,
        });
      } catch {
        return portError("invalid", cfg.ERR_ATTEMPT);
      }

      const artifactsPages = await paginate(
        api,
        `/repos/${owner}/${name}/actions/runs/${runId}/artifacts`,
        {},
        "artifacts",
        cfg.ERR_ARTIFACTS_PAGINATION,
      );
      if (!artifactsPages.ok) return artifactsPages;
      if (tracker.isExhausted()) {
        return portError("unavailable", cfg.ERR_TIMEOUT);
      }
      const targetName = `${cfg.RECEIPT_ARTIFACT_PREFIX}${runId}-${attempt}`;
      // Structural identity for every listing entry: unrelated artifact types
      // may legitimately be larger than the receipt cap, expired or digest-
      // free; only exact target-name count and duplicate ids are decided
      // before any receipt-specific check.
      const seenArtifactIds = new Set<number>();
      let nameMatchCount = 0;
      let selectedIndex = -1;
      for (const [index, item] of artifactsPages.value.items.entries()) {
        let validated: { id: number; name: string };
        try {
          validated = proof.validateArtifactIdentity(item);
        } catch {
          return portError("invalid", cfg.ERR_ARTIFACTS);
        }
        if (seenArtifactIds.has(validated.id)) {
          return portError("invalid", cfg.ERR_ARTIFACTS);
        }
        seenArtifactIds.add(validated.id);
        if (validated.name === targetName) {
          nameMatchCount += 1;
          selectedIndex = index;
        }
      }
      if (nameMatchCount === 0) {
        return portOk<BuildReceiptLookupV1>({ status: "absent" });
      }
      if (nameMatchCount > 1) {
        return portOk<BuildReceiptLookupV1>({
          status: "ambiguous",
          detail: "multiple matching receipt artifacts",
        });
      }
      let artifact: proof.VerifiedArtifact;
      try {
        const selected = proof.validateReceiptArtifact(
          artifactsPages.value.items[selectedIndex],
          {
            runId,
            revision,
            baseBranch,
            repoId,
            nowMs,
          },
        );
        artifact = {
          id: selected.id,
          sizeInBytes: selected.sizeInBytes,
          digestHex: selected.digestHex,
        };
      } catch (error) {
        if (error instanceof proof.ArtifactExpired) {
          return portError("invalid", cfg.ERR_ARTIFACT_EXPIRED);
        }
        return portError("invalid", cfg.ERR_ARTIFACTS);
      }

      // --- Step 5: authenticated 302 + signed storage download -----------
      const zipResult = await api.get(
        `/repos/${owner}/${name}/actions/artifacts/${artifact.id}/zip`,
        null,
        true,
      );
      if (!zipResult.ok) return zipResult;
      const zipResponse = zipResult.value;
      if (zipResponse.status === 404 || zipResponse.status === 410) {
        api.ctx.cancelBody(zipResponse.body);
        return portOk<BuildReceiptLookupV1>({ status: "absent" });
      }
      if (zipResponse.status !== 302) {
        api.ctx.cancelBody(zipResponse.body);
        return mapHttpStatus(zipResponse.status);
      }
      const location = zipResponse.headers.get("location");
      if (location === null) return portError("invalid", cfg.ERR_SIGNED_URL);
      const signedLocation = proof.parseSignedLocation(location);
      if (signedLocation === null) {
        return portError("invalid", cfg.ERR_SIGNED_URL);
      }

      const storageResult = await api.downloadSigned(signedLocation);
      if (!storageResult.ok) return storageResult;
      const storageResponse = storageResult.value;
      if (storageResponse.status !== 200) {
        api.ctx.cancelBody(storageResponse.body);
        return portError("unavailable", cfg.ERR_STORAGE);
      }
      const archiveBytes = await readBoundedBytes(
        api,
        storageResponse,
        cfg.MAX_ARCHIVE_BYTES,
        cfg.ERR_ARTIFACT,
      );
      if (!archiveBytes.ok) return archiveBytes;
      if (archiveBytes.value.length !== artifact.sizeInBytes) {
        return portError("invalid", cfg.ERR_ARTIFACT_SIZE);
      }
      let actualDigest: string;
      try {
        const guarded = await guardUntil(
          proof.sha256Hex(archiveBytes.value),
          tracker.remainingMs(),
        );
        if (guarded === DEADLINE) {
          return portError("unavailable", cfg.ERR_TIMEOUT);
        }
        actualDigest = guarded;
      } catch {
        return portError("invalid", cfg.ERR_ARTIFACT);
      }
      if (actualDigest !== artifact.digestHex) {
        return portError("invalid", cfg.ERR_ARTIFACT_DIGEST);
      }

      // --- Step 6: bounded archive decode + strict producer schema -------
      if (tracker.isExhausted()) {
        return portError("unavailable", cfg.ERR_TIMEOUT);
      }
      const decoded = decodeBuildReceiptArchive(archiveBytes.value);
      if (!decoded.ok) return decoded;
      const receipt = proof.parseProducerReceipt(decoded.value, {
        repoFull,
        runId: String(runId),
        attempt: String(attempt),
        workflowRef,
        revision,
        project: this.project,
        transaction: `github-actions:${repoFull}:${runId}:${attempt}`,
      });
      if (receipt === null) return portError("invalid", cfg.ERR_RECEIPT);
      if (tracker.isExhausted()) {
        return portError("unavailable", cfg.ERR_TIMEOUT);
      }

      // --- Step 7: latest-run attempt recheck before returning -----------
      const recheckResult = await api.getJson(
        `/repos/${owner}/${name}/actions/runs/${runId}`,
      );
      if (!recheckResult.ok) return recheckResult;
      let recheckMatches: boolean;
      try {
        const current = cfg.asRecord(recheckResult.value);
        const repository = cfg.repoField(current);
        const headRepository = cfg.headRepoField(current);
        const recheckConclusion = cfg.asString(
          cfg.field(current, "conclusion"),
        );
        recheckMatches = cfg.asPosInt(cfg.field(current, "id")) === runId &&
          cfg.asPosInt(cfg.field(current, "run_attempt")) === attempt &&
          recheckConclusion === conclusion &&
          cfg.asString(cfg.field(current, "event")) === "push" &&
          cfg.asString(cfg.field(current, "status")) === "completed" &&
          cfg.asString(cfg.field(current, "head_sha")) === revision &&
          cfg.asString(cfg.field(current, "head_branch")) === baseBranch &&
          cfg.asPosInt(cfg.field(current, "workflow_id")) === workflowId &&
          repository.fullName === repoFull && repository.id === repoId &&
          headRepository.fullName === repoFull &&
          headRepository.id === repoId;
      } catch {
        return portError("invalid", cfg.ERR_RUNS);
      }
      if (!recheckMatches) return portError("unavailable", cfg.ERR_RERUN);
      if (tracker.isExhausted()) {
        return portError("unavailable", cfg.ERR_TIMEOUT);
      }

      return portOk({
        status: "found",
        receipt: {
          buildTransactionId: receipt.buildTransactionId,
          identity: {
            gitSha: revision,
            revisionId: receipt.revisionId,
          },
        },
      });
    } catch {
      if (tracker.isExhausted()) {
        return portError("unavailable", cfg.ERR_TIMEOUT);
      }
      return portError("unavailable", cfg.ERR_UNEXPECTED);
    } finally {
      api.ctx.dispose();
    }
  }
}
