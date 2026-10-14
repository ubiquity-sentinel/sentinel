import assert from "node:assert/strict";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import {
  denialConsumerSource,
  siblingDenialConsumerSource,
} from "./causal-sandbox-helpers.ts";

export const SIBLING_CACHE_FILE = "sentinel-causal-sibling.txt";
export const SIBLING_CACHE_SENTINEL = "public sibling cache sentinel\n";

export interface DenialCaseV1 {
  name: string;
  /** Committed consumer source (attempted denied op, fixed protocols). */
  source: (toyRoot: string) => string;
  /** Commit a gitlink symlink for `src` (symlink-import negative). */
  symlinkSrc?: boolean;
  /**
   * Precreates a PUBLIC synthetic sibling cache sentinel OUTSIDE the sandbox
   * before the execution that attempts the crossed-boundary read (target
   * derived from the actual consumer cwd, never env) and verifies the target
   * exists, so the denial cannot be a missing-file accident. The recording
   * wrapper records the actual command result.
   */
  prepareConsumer?: (input: ReplayCommandInputV1) => Promise<void>;
  /** Which snapshot execution must produce the intended denial (exit 2 +
   * fixed marker); undefined for the uncaught-denial cases. */
  denialInOriginal?: boolean;
}

/**
 * Trusted recording wrapper over the REAL runtime — never a fake runtime, no
 * predicate substitutes for any execution. It precreates public synthetic
 * sibling sentinels outside the sandbox, verifies they exist, and records
 * the ACTUAL command result so a denial is asserted on the correct execution.
 */
export class RecordingRealRuntime implements ReplayRuntimeV1 {
  readonly runs: {
    input: ReplayCommandInputV1;
    result: ReplayCommandResultV1;
  }[] = [];

  constructor(
    private readonly inner: ReplayRuntimeV1,
    private readonly prepare: (input: ReplayCommandInputV1) => Promise<void> =
      async () => {},
  ) {}

  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    await this.prepare(input);
    const result = await this.inner.run(input);
    this.runs.push({ input, result });
    return result;
  }
}

/** Precreate the sibling cache sentinel for the attempting execution only. */
export function siblingCacheSentinelPrepare(
  attemptInOriginal: boolean,
): (input: ReplayCommandInputV1) => Promise<void> {
  return async (input: ReplayCommandInputV1) => {
    if (input.args[0] !== "-p") return;
    const inOriginal = input.cwd.endsWith("/original");
    if (inOriginal !== attemptInOriginal) return;
    const siblingHome = inOriginal ? "home-sanitized" : "home-original";
    const target =
      `${input.cwd}/../${siblingHome}/.cache/deno/${SIBLING_CACHE_FILE}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(target, SIBLING_CACHE_SENTINEL);
    const info = await Deno.lstat(target);
    assert.ok(
      info.isFile,
      "the public sibling cache sentinel must exist outside the sandbox",
    );
  };
}

/**
 * The intended sibling denial must be OBSERVED on the correct execution: the
 * attempting snapshot's consumer run exits 2 and prints the FIXED synthetic
 * denial marker — never only `verify() === null`. For a sanitized->original
 * attempt the original run must first emit the valid safe failure protocol
 * (exit 1), proving the sanitized execution actually happened.
 */
export function assertDenialRun(
  recording: RecordingRealRuntime,
  name: string,
  denialInOriginal: boolean,
): void {
  const consumerRuns = recording.runs.filter((run) =>
    run.input.args[0] === "-p"
  );
  const expectedText = denialInOriginal ? "original" : "sanitized";
  const denialRun = consumerRuns.find((run) =>
    run.input.cwd.endsWith(`/${expectedText}`)
  );
  assert.ok(
    denialRun !== undefined,
    `${name}: the attempting (${expectedText}) execution must have run`,
  );
  assert.equal(denialRun!.result.exitCode, 2, `${name}: intended denial is 2`);
  const stdout = new TextDecoder().decode(denialRun!.result.stdout);
  assert.ok(
    stdout.includes("sentinel-causal-failure:denied"),
    `${name}: the fixed synthetic denial marker must be on stdout`,
  );
  if (!denialInOriginal) {
    // sanitized->original: the first (original) run emitted the valid safe
    // protocol, so the sanitized execution actually happened.
    const originalRun = consumerRuns.find((run) =>
      run.input.cwd.endsWith("/original")
    );
    assert.ok(originalRun !== undefined, `${name}: original run must exist`);
    assert.equal(originalRun!.result.exitCode, 1, `${name}: valid original`);
    const originalStdout = new TextDecoder().decode(originalRun!.result.stdout);
    assert.ok(
      originalStdout.includes(
        "sentinel-causal-failure:stream terminated unexpectedly",
      ),
      `${name}: original must print the fixed safe failure protocol`,
    );
    assert.equal(
      consumerRuns.length,
      2,
      `${name}: the sanitized execution must actually have run`,
    );
  } else {
    assert.equal(
      consumerRuns.length,
      1,
      `${name}: a denied original aborts before the sanitized run`,
    );
  }
}

export const DENIAL_CASES: DenialCaseV1[] = [
  {
    name: "outside static TS import",
    source: (toyRoot) =>
      denialConsumerSource(
        `import { forbidden } from "${toyRoot}/outside.ts";\nvoid forbidden;`,
      ),
  },
  {
    name: "outside static JSON import",
    source: (toyRoot) =>
      denialConsumerSource(
        `import data from "${toyRoot}/outside.json" with { type: "json" };\nvoid data;`,
      ),
  },
  {
    name: "symlinked module import",
    source: () =>
      denialConsumerSource(
        `import { forbidden } from "../src/app.ts";\nvoid forbidden;`,
      ),
    symlinkSrc: true,
  },
  {
    name: "runtime read outside the snapshot",
    source: () =>
      denialConsumerSource(`await Deno.readTextFile("/etc/passwd");`),
  },
  {
    name: "sibling snapshot read original to sanitized",
    source: () =>
      siblingDenialConsumerSource(true, "../sanitized/scripts/replay.ts"),
    denialInOriginal: true,
  },
  {
    name: "sibling snapshot read sanitized to original",
    source: () =>
      siblingDenialConsumerSource(false, "../original/scripts/replay.ts"),
    denialInOriginal: false,
  },
  {
    name: "sibling cache read original to sanitized",
    source: () =>
      siblingDenialConsumerSource(
        true,
        `../home-sanitized/.cache/deno/${SIBLING_CACHE_FILE}`,
      ),
    prepareConsumer: siblingCacheSentinelPrepare(true),
    denialInOriginal: true,
  },
  {
    name: "sibling cache read sanitized to original",
    source: () =>
      siblingDenialConsumerSource(
        false,
        `../home-original/.cache/deno/${SIBLING_CACHE_FILE}`,
      ),
    prepareConsumer: siblingCacheSentinelPrepare(false),
    denialInOriginal: false,
  },
  {
    name: "write outside the allowed scope",
    source: () =>
      denialConsumerSource(
        `await Deno.writeTextFile(Deno.cwd() + "/leak.txt", "forbidden");`,
      ),
  },
  {
    name: "network access",
    source: () =>
      denialConsumerSource(
        `await (await fetch("https://example.com")).text();`,
      ),
  },
  {
    name: "process spawn",
    source: () =>
      denialConsumerSource(
        `await new Deno.Command("echo", { args: ["forbidden"] }).output();`,
      ),
  },
];
