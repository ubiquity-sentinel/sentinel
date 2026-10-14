// One owner for release dependencies, health proofs and expected-head CAS state.
import type { Clock } from "../contracts/ports.ts";
import type {
  DenoReleasePort,
  HealthSampleConfigV1,
  HealthSampleV1,
  PortResultV1,
  ReleaseStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { StabilityPolicyV1 } from "../contracts/repository-config.ts";
import type { ReleasePhaseV1, ReleaseRecordV1 } from "../contracts/release.ts";
import type { ReleaseTargetEnvironmentV1 } from "../contracts/release.ts";
import type {
  DeploymentIdentityV1,
  RepositoryIdentityV1,
} from "../contracts/shared.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { validateStabilityPolicy } from "./config.ts";
import type { ReleaseTargetConfigV1 } from "./config.ts";
import type { BuildReceiptResolverV1 } from "./resolver.ts";
import {
  isTerminalPhase,
  type LoadedContextV1,
  type ReleaseControllerOptions,
  type ReleaseCycleResultV1,
  sameIdentity,
  sameRepository,
} from "./controller-common.ts";

export class ReleaseControllerState {
  readonly repository: RepositoryIdentityV1;
  readonly environment: ReleaseTargetEnvironmentV1;
  readonly target: ReleaseTargetConfigV1;
  readonly policy: StabilityPolicyV1;
  readonly stateRead: StateReadView;
  readonly stateWrite: ReleaseStateWriter;
  readonly deno: DenoReleasePort;
  readonly resolver: BuildReceiptResolverV1;
  readonly clock: Clock;
  /** Exact expected release-state head for this run's CAS writes. */
  private expectedHead: GitSha | null = null;

  constructor(options: ReleaseControllerOptions) {
    const check = validateStabilityPolicy(options.policy);
    if (!check.ok) {
      // Construction-time config fault: static detail, never echoed values.
      throw new Error(`release controller config rejected: ${check.detail}`);
    }
    this.repository = options.repository;
    this.environment = options.environment;
    this.target = options.target;
    this.policy = options.policy;
    this.stateRead = options.stateRead;
    this.stateWrite = options.stateWrite;
    this.deno = options.deno;
    this.resolver = options.resolver;
    this.clock = options.clock;
  }

  async loadContext(): Promise<LoadedContextV1 | null> {
    const release = await this.stateRead.readRelease();
    if (!release.ok) return null;
    const repair = await this.stateRead.readRepair();
    if (!repair.ok) return null;
    const releaseSnapshot: ReleaseStateSnapshotV1 =
      release.value.status === "found" ? release.value.snapshot : {
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: null,
        sequence: 0,
        updatedAt: this.clock.now(),
        releases: [],
        hostedRuntimes: [],
        hostedReleases: [],
        githubCooldowns: [],
      };
    const repairSnapshot = repair.value.status === "found"
      ? repair.value.snapshot
      : null;
    const requests = (repairSnapshot?.releaseRequests ?? [])
      .filter((request) =>
        request.status === "open" &&
        sameRepository(request.target.repository, this.repository) &&
        request.target.environment === this.environment
      )
      .sort((a, b) =>
        a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );

    const matching = releaseSnapshot.releases.filter((record) =>
      sameRepository(record.repository, this.repository) &&
      record.environment === this.environment
    );
    this.expectedHead = release.value.status === "found"
      ? release.value.head
      : null;
    return {
      requests,
      active: matching.filter((record) => !isTerminalPhase(record.phase)),
      terminal: matching.filter((record) => isTerminalPhase(record.phase)),
      releaseHead: this.expectedHead,
    };
  }

  identityHealthConfig(): HealthSampleConfigV1 {
    return {
      baseUrl: this.target.managedBaseUrl,
      healthPath: this.target.acceptance.healthPath,
      managedBodyMarker: this.target.acceptance.managedBodyMarker,
      managedHeaders: [...this.target.acceptance.managedHeaders],
      domain: null,
    };
  }

  proofHealthConfig(
    expected: DeploymentIdentityV1,
  ): HealthSampleConfigV1 {
    return {
      baseUrl: this.target.managedBaseUrl,
      healthPath: this.target.acceptance.healthPath,
      managedBodyMarker: this.target.acceptance.managedBodyMarker,
      managedHeaders: [
        ...this.target.acceptance.managedHeaders,
        {
          name: this.target.identityHeaders.gitSha,
          value: expected.gitSha,
        },
        {
          name: this.target.identityHeaders.revisionId,
          value: expected.revisionId,
        },
      ],
      domain: null,
    };
  }

  async observeManaged(): Promise<
    { status: "ok"; sample: HealthSampleV1 } | { status: "error" }
  > {
    const result = await this.deno.sampleHealth(this.identityHealthConfig());
    if (!result.ok) return { status: "error" };
    return { status: "ok", sample: result.value };
  }

  async proveManaged(
    expected: DeploymentIdentityV1,
  ): Promise<
    { status: "ok"; sample: HealthSampleV1 } | { status: "error" }
  > {
    const result = await this.deno.sampleHealth(
      this.proofHealthConfig(expected),
    );
    if (!result.ok) return { status: "error" };
    return { status: "ok", sample: result.value };
  }

  async probeCustom(
    expected: DeploymentIdentityV1,
  ): Promise<
    | { status: "ok" }
    | { status: "hard-fail" }
    | { status: "warned"; warnings: string[] }
    | { status: "blocked"; detail: string }
    | null
  > {
    if (this.target.customBaseUrl === null) return null;
    const result = await this.deno.sampleHealth({
      baseUrl: this.target.customBaseUrl,
      healthPath: this.target.acceptance.healthPath,
      managedBodyMarker: this.target.acceptance.managedBodyMarker,
      managedHeaders: [
        ...this.target.acceptance.managedHeaders,
        {
          name: this.target.identityHeaders.gitSha,
          value: expected.gitSha,
        },
        {
          name: this.target.identityHeaders.revisionId,
          value: expected.revisionId,
        },
      ],
      domain: this.target.acceptance.domain,
    });
    if (!result.ok) {
      return {
        status: "blocked",
        detail: "custom gateway probe is unavailable",
      };
    }
    const sample = result.value;
    if (sample.httpStatus === 200) {
      if (
        sample.status !== "healthy" || sample.identity === null ||
        !sameIdentity(sample.identity, expected)
      ) {
        return { status: "hard-fail" };
      }
      return { status: "ok" };
    }
    if (sample.httpStatus === 403 && sample.headersMatch === true) {
      // The target's identified exception: a verified Cloudflare Bot Fight
      // Mode challenge on the gateway runner, never a deployment mismatch.
      return {
        status: "warned",
        warnings: [
          "custom gateway returns a verified Cloudflare-identified 403",
        ],
      };
    }
    return {
      status: "blocked",
      detail: "custom gateway identity cannot be verified",
    };
  }

  async writeSnapshot(
    context: LoadedContextV1,
    updated: ReleaseRecordV1,
  ): Promise<boolean> {
    const read = await this.stateRead.readRelease();
    if (!read.ok) return false;
    if (read.value.status !== "found") {
      if (context.releaseHead !== null) return false;
    } else if (read.value.head !== this.expectedHead) {
      return false;
    }
    const priorSnapshot: ReleaseStateSnapshotV1 = read.value.status === "found"
      ? read.value.snapshot
      : {
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: null,
        sequence: 0,
        updatedAt: this.clock.now(),
        releases: [],
        hostedRuntimes: [],
        hostedReleases: [],
        githubCooldowns: [],
      };
    const nextRecords = priorSnapshot.releases
      .filter((record) => record.id !== updated.id)
      .concat([updated]);
    const next: ReleaseStateSnapshotV1 = {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: read.value.status === "found" ? read.value.head : null,
      sequence: priorSnapshot.sequence + 1,
      updatedAt: this.clock.now(),
      releases: nextRecords,
      hostedRuntimes: priorSnapshot.hostedRuntimes,
      hostedReleases: priorSnapshot.hostedReleases,
      githubCooldowns: priorSnapshot.githubCooldowns,
    };
    const expectedHead = read.value.status === "found" ? read.value.head : null;
    const write = await this.stateWrite.writeRelease(next, expectedHead);
    if (!write.ok || write.value.status !== "applied") return false;
    this.expectedHead = write.value.head;
    return true;
  }

  async persistAndReport(
    updated: ReleaseRecordV1,
    context: LoadedContextV1,
    phase: ReleasePhaseV1,
  ): Promise<PortResultV1<ReleaseCycleResultV1>> {
    const write = await this.writeSnapshot(context, updated);
    if (!write) {
      return portOk({ status: "conflict", recordId: updated.id, warnings: [] });
    }
    return portOk({
      status: "persisted",
      recordId: updated.id,
      phase,
      warnings: [],
    });
  }

  blocked(
    recordId: string | null,
    detail: string,
  ): PortResultV1<ReleaseCycleResultV1> {
    return portOk({ status: "blocked", recordId, detail, warnings: [] });
  }
}
