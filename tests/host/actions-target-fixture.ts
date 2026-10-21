/** Shared credential-free hosted test fixtures; this module registers no tests. */
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import {
  parseAppInstallationId,
  type runActionsTargetCycles,
  scopeTargetConfigV1,
} from "../../src/host/actions.ts";
import {
  composeLocalGitHub,
  createLocalRepositoryConfig,
  LocalSessionTracker,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import { createTargetConfigV1 } from "../../src/host/targets.ts";
import { FakeClock, FakeModel, MemoryState } from "../repair/helpers.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import {
  APP_PUBLISHER,
  FakeGate,
  response,
  ScriptedHttp,
} from "./actions-ci-fixture.ts";

// ---------------------------------------------------------------------------
// Multi-target host: one separately targeted cycle per committed repository,
// sharing the state store, cooldown gate, admission budget, model port and one
// absolute run deadline.
// ---------------------------------------------------------------------------

/** A second committed target, distinct from the sentinel self-repository. */
export const FOREIGN_REPO = "ai.ubq.fi";

/** A third committed target that the deadline test never starts. */
export const THIRD_REPO = "web";

/** The one fixed App installation scope every non-sentinel target uses. */
export const APP_INSTALLATION = parseAppInstallationId(undefined);

export function unique(values: readonly number[]): number[] {
  return [...new Set(values)];
}

export function issueReadPaths(http: ScriptedHttp): string[] {
  return http.calls
    .filter((call) =>
      call.method === "GET" && new URL(call.url).pathname.endsWith("/issues")
    )
    .map((call) => new URL(call.url).pathname);
}

interface TargetHostRigV1 {
  configs: RepositoryConfigV1[];
  clock: FakeClock;
  state: MemoryState;
  gate: FakeGate;
  http: ScriptedHttp;
  budget: RollingStartBudget;
  /** The exact production port composition, targeted at one config. */
  compose(config: RepositoryConfigV1): GitHubPort;
}

/**
 * The committed configurations exactly as the host scopes them: the sentinel
 * self-target keeps the reserved no-App scope 0 and every foreign target is
 * addressed under the App installation scope. Ports are the REAL
 * `composeLocalGitHub` composition over the scripted transport.
 */
export function makeTargetHostRig(names: readonly string[]): TargetHostRigV1 {
  const self = createLocalRepositoryConfig();
  const configs = names.map((name) => {
    const isSelf = name === "sentinel";
    const owner = isSelf ? "Ubiquity-Sentinel" : "ubiquity";
    const config = createTargetConfigV1(
      self,
      { slug: `${owner}/${name}`, owner, name },
      isSelf ? self.baseBranch : "main",
    );
    return scopeTargetConfigV1(config, self.repository, APP_INSTALLATION);
  });
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const gate = new FakeGate();
  const http = new ScriptedHttp();
  for (const name of names) {
    const owner = name === "sentinel" ? "Ubiquity-Sentinel" : "ubiquity";
    http.on("GET", `/repos/${owner}/${name}/issues`, () => response(200, []));
  }
  const tracker = new LocalSessionTracker();
  const budget = new RollingStartBudget({ clock, state, configs });
  return {
    configs,
    clock,
    state,
    gate,
    http,
    budget,
    compose: (config) =>
      composeLocalGitHub({
        clock,
        state,
        gate,
        http: http.transport,
        token: "dummy-token",
        login: APP_PUBLISHER,
        invocationId: `test-${config.repository.name}`,
        stateRoot: "/tmp/sentinel-multi-target-state",
        sourcePath: "/tmp/sentinel-multi-target-source",
        scratch: "/tmp/sentinel-multi-target-scratch",
        reviewCheckout: "/tmp/sentinel-multi-target-review",
        reviewClientHome: "/tmp/sentinel-multi-target-clients",
        reviewTmpDir: "/tmp/sentinel-multi-target-tmp",
        reviewDenoDir: "/tmp/sentinel-multi-target-deno",
        trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        codexExecutable: "/usr/bin/false",
        tracker,
        repository: config.repository,
      }),
  };
}

/** The one shared capability set, with explicit test overrides. */
export function targetCycleInput(
  rig: TargetHostRigV1,
  overrides: Partial<Parameters<typeof runActionsTargetCycles>[0]> = {},
): Parameters<typeof runActionsTargetCycles>[0] {
  return {
    clock: rig.clock,
    state: rig.state,
    configs: rig.configs,
    controllerSha: SHA1,
    githubCooldown: rig.gate,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model: new FakeModel(),
    budget: rig.budget,
    deadline: rig.clock.now() + 60 * 60_000,
    stepLimit: 16,
    modelStartsEnabled: false,
    composeGithub: rig.compose,
    ...overrides,
  };
}
