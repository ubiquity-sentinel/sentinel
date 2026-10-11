import type {
  CommandId,
  FixtureDigest,
  GitSha,
  WorkItemId,
} from "../../src/contracts/brands.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  PortResultV1,
  ReplayRunRequestV1,
} from "../../src/contracts/ports.ts";
import {
  computeReplayFixtureDigest,
  markerProofParser,
} from "../../src/replay/fixture.ts";
import type {
  FixtureResolverV1,
  ReplayPolicyV1,
  ResolvedFixtureV1,
} from "../../src/replay/fixture.ts";
import type {
  ReplayIsolationCapabilityV1,
  ReplayPortOptions,
  ReplaySourceV1,
} from "../../src/replay/port.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type { ReplayRuntimeV1 } from "../../src/replay/runtime.ts";
import {
  FIXTURE_JSON,
  REGRESSION_TEST,
  REPLAY_SCRIPT,
} from "./toy-app-fixtures.ts";

// Test-only helpers for the ReplayPort suite (m03). Everything here creates
// CREDENTIAL-FREE real local toy repositories and trusted test fixtures; no
// network, no model calls, no paid upstream. The toy app is a tiny streaming
// gateway handler whose original revision 500s on a missing completion
// terminator and whose candidate revision tolerates it — the recorded
// upstream fixture is replayed locally through the handler.
export const TEST_ID = "gateway:stream-termination";
export const FIXTURE_REF = "fixture://captures/toy/upstream.json";
export const TOY_REPOSITORY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 12345,
} as const;

export interface ToyApp {
  root: string;
  env: Record<string, string>;
  originalSha: GitSha;
  candidateSha: GitSha;
  unrelatedSha: GitSha;
}

export {
  FIXTURE_JSON,
  REGRESSION_TEST,
  REPLAY_SCRIPT,
  TOY_APP_FIXED,
  TOY_BUNDLE_FILES,
} from "./toy-app-fixtures.ts";
export {
  commitSymlink,
  commitWith,
  createToyApp,
  gitRun,
  revParse,
  testGitEnv,
} from "./toy-git-helpers.ts";
export type { GitRunResult } from "./toy-git-helpers.ts";

export function toyBundle(
  overrides: Partial<ResolvedFixtureV1> = {},
): ResolvedFixtureV1 {
  return {
    testIds: [TEST_ID],
    expectedFailure: {
      reason: "missing completion terminator produces 500",
      match: { kind: "contains", text: "stream terminated unexpectedly" },
    },
    entries: [
      { path: "tests/regression_test.ts", bytes: encode(REGRESSION_TEST) },
      { path: "tests/fixtures/upstream.json", bytes: encode(FIXTURE_JSON) },
      { path: "scripts/replay.ts", bytes: encode(REPLAY_SCRIPT) },
    ],
    provenance: {
      sanitized: true,
      sanitizer: "toy-sanitizer",
      provenanceRef: "fixture://provenance/toy/upstream",
      redacted: false,
      note: "recorded upstream replayed locally; no credentials",
    },
    ...overrides,
  };
}

export function toyPolicy(): ReplayPolicyV1 {
  return {
    bundleScopes: ["tests/", "scripts/"],
    maxFixtureBytes: 256 * 1024,
    maxEntryBytes: 128 * 1024,
    proof: markerProofParser(),
  };
}

/**
 * Explicitly trusted fixture-mode capability for local toy tests only. The
 * callable `run` is an explicit fixture-only boundary: it delegates to the
 * supplied test runtime, or to a fresh DenoReplayRuntime when none is given.
 * It never stands in for a production restricted-execution host.
 */
export function toyIsolation(
  runtime?: ReplayRuntimeV1,
): ReplayIsolationCapabilityV1 {
  const fixtureRuntime = runtime ??
    new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin");
  return {
    attestation: {
      version: "v1",
      host: "toy-restricted-host",
      restrictedExecution: true,
      boundary:
        "test fixture mode: disposable local toy checkout, no external calls",
      attestationRef: "fixture://isolation/toy",
    },
    run: (input) => fixtureRuntime.run(input),
  };
}

export function toySource(root: string): ReplaySourceV1 {
  return { kind: "local", path: root };
}

export function toyConfig(): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: TOY_REPOSITORY,
    baseBranch: "main",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: {
        replay: {
          executable: "deno",
          args: ["task", "replay"],
          maxDurationMs: 15000,
          maxOutputBytes: 262144,
        },
        test: {
          executable: "deno",
          args: ["task", "test"],
          maxDurationMs: 15000,
          maxOutputBytes: 262144,
        },
      },
    },
    protectedPaths: ["src/"],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: null,
    sessionBound: null,
    retention: null,
    stabilityPolicy: null,
  });
}

export function toyOptions(
  toyRoot: string,
  scratchDir: string,
  overrides: Partial<ReplayPortOptions> = {},
): ReplayPortOptions {
  return {
    config: toyConfig(),
    source: toySource(toyRoot),
    scratchDir,
    fixtures: new ToyFixtureResolver(toyBundle()),
    policy: toyPolicy(),
    // Bind the fixture boundary to the caller-supplied runtime BEFORE the
    // override spread, so a deliberate `isolation: undefined` stays invalid
    // instead of being silently repaired by a later override.
    isolation: toyIsolation(overrides.runtime),
    ...overrides,
  };
}

export function makePort(
  toyRoot: string,
  scratchDir: string,
  overrides: Partial<ReplayPortOptions> = {},
): ReplayPortImpl {
  return new ReplayPortImpl(toyOptions(toyRoot, scratchDir, overrides));
}

export async function replayRequest(
  bundle: ResolvedFixtureV1,
  revision: GitSha,
  overrides: Record<string, unknown> = {},
): Promise<ReplayRunRequestV1> {
  const digest = await computeReplayFixtureDigest(bundle.entries);
  return {
    taskId: "incident:toy-0001" as WorkItemId,
    repository: TOY_REPOSITORY,
    revision,
    commandId: "test" as CommandId,
    fixtureRef: FIXTURE_REF,
    fixtureDigest: digest,
    testIds: bundle.testIds,
    outputLimitBytes: 262144,
    ...overrides,
  } as ReplayRunRequestV1;
}

// ---------------------------------------------------------------------------
// Trusted test resolver (injected fixture transport; no product logic)
// ---------------------------------------------------------------------------

export class ToyFixtureResolver implements FixtureResolverV1 {
  constructor(private readonly bundle: ResolvedFixtureV1) {}

  resolveFixture(ref: string): Promise<PortResultV1<ResolvedFixtureV1>> {
    if (ref !== FIXTURE_REF) {
      return Promise.resolve(
        portError("not_found", `no fixture resolved for ref ${ref}`),
      );
    }
    return Promise.resolve(portOk(this.bundle));
  }
}

// ---------------------------------------------------------------------------
// Credential-free git helpers (mirror the state suite's environment shape)
// ---------------------------------------------------------------------------

export function bundleDigest(
  text: Record<string, string>,
): Promise<FixtureDigest> {
  const entries = Object.entries(text)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => ({ path, bytes: encode(content) }));
  return computeReplayFixtureDigest(entries);
}

export async function sha256HexText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
