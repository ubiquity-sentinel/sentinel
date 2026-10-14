import { FakeGithub } from "./helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  MergeOutcomeV1,
  MergeRequestV1,
  PortResultV1,
  PullRequestCreateV1,
  PullRequestPublishV1,
} from "../../src/contracts/ports.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import type { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type { GatewayAuthProviderV1 } from "../../src/adapters/gateway/http.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";

/** Exact-head fake GitHub: each head gets its own PR number. The inherited
 * lifecycle maps own the exact PR/ref observations, so create and merge
 * delegate to super and every read observes the same exact objects. */
export class ExactHeadFakeGithub extends FakeGithub {
  readonly mergedHeads: GitSha[] = [];
  readonly publishedHeads: GitSha[] = [];

  override pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<"applied" | "ambiguous">> {
    this.publishedHeads.push(sha);
    return super.pushHead(ref, sha, expectedRef);
  }

  override async createPullRequest(
    request: PullRequestCreateV1,
  ): Promise<PortResultV1<PullRequestPublishV1>> {
    const published = await super.createPullRequest(request);
    // Keep the exact per-head PR allocation in the call recording; the
    // inherited lifecycle fake already allocated it deterministically.
    if (published.ok && published.value.number !== null) {
      this.calls.push(`createPr:${published.value.number}`);
    }
    return published;
  }

  override async mergePullRequest(
    request: MergeRequestV1,
  ): Promise<PortResultV1<MergeOutcomeV1>> {
    this.mergedHeads.push(request.expectedHead);
    // The inherited lifecycle merge closes the exact requested PR on the exact
    // requested head; the merge receipt is never the global last push.
    return await super.mergePullRequest(request);
  }
}

/** Recording wrapper over the REAL Deno replay runtime (no product logic). */
export class RecordingReplayRuntime implements ReplayRuntimeV1 {
  readonly runs: {
    input: ReplayCommandInputV1;
    outcome: string | null;
    exitCode: number | null;
    outputText: string;
  }[] = [];
  constructor(private readonly inner: DenoReplayRuntime) {}

  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    const result = await this.inner.run(input);
    this.runs.push({
      input,
      outcome: result.outcome,
      exitCode: result.exitCode,
      outputText: new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Composed repair host fixture.
// ---------------------------------------------------------------------------

export function gatewayAuth(): GatewayAuthProviderV1 {
  return {
    headers: () =>
      Promise.resolve(
        {
          ok: true,
          value: { Authorization: "Bearer synthetic-token" },
        } as const,
      ),
  };
}

export function composedConfig(
  repository: RepositoryIdentityV1,
): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository,
    baseBranch: "development",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: {
        replay: {
          executable: "deno",
          args: ["task", "replay"],
          maxDurationMs: 60_000,
          maxOutputBytes: 262_144,
        },
        test: {
          executable: "deno",
          args: ["task", "test"],
          maxDurationMs: 60_000,
          maxOutputBytes: 262_144,
        },
      },
    },
    protectedPaths: [],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: { perHour: 5, perSevenDays: 20 },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    retention: null,
    stabilityPolicy: null,
  });
}
