import assert from "node:assert/strict";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { ResolvedFixtureV1 } from "../../src/replay/fixture.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import type { ReplayPortOptions } from "../../src/replay/port.ts";
import {
  TOY_REPOSITORY,
  toyConfig,
  ToyFixtureResolver,
  toyOptions,
} from "./helpers.ts";

export const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
export const testsDir = decodeURIComponent(here.pathname).replace(
  /\/port-helpers\.ts$/,
  "",
);

export async function withFixture<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({
    prefix: ".replay-tmp-",
    dir: testsDir,
  });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

export function assertPortOk<T>(
  result: PortResultV1<T>,
): T {
  assert.ok(result.ok, `expected port ok, got ${JSON.stringify(result)}`);
  return result.value;
}

/** Port whose trusted resolver serves exactly the given fixture bundle. */
export function portWithBundle(
  toyRoot: string,
  scratchDir: string,
  bundle: ResolvedFixtureV1,
  overrides: Partial<ReplayPortOptions> = {},
): ReplayPortImpl {
  return new ReplayPortImpl({
    ...toyOptions(toyRoot, scratchDir, overrides),
    fixtures: new ToyFixtureResolver(bundle),
    ...overrides,
  });
}

export function configWithCommand(
  commandId: "test" | "replay",
  command: {
    executable: string;
    args: string[];
    maxDurationMs: number;
    maxOutputBytes: number;
  },
): RepositoryConfigV1 {
  const base = toyConfig();
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
        ...base.commandRegistry.commands,
        [commandId]: command,
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

export const text = new TextEncoder();
