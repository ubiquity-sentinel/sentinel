/** Protected native wrapper. Test output cannot replace its final, unique carrier. */
import type { NativeCiProofV1 } from "../src/contracts/native-ci.ts";
const NATIVE_CI_MARKER = "sentinel_native_ci_v1:";

export interface NativeCiWrapperV1 {
  env(name: string): string | undefined;
  readEvent(path: string): Promise<string>;
  git(args: string[]): Promise<string>;
  harness(): Promise<number>;
  emit(line: string): void;
}

/** A skipped, cancelled, missing or failed matrix never authorizes the carrier. */
export function nativeCiAggregateStatus(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return 1;
  }
  const jobs = value as Record<string, { result?: unknown } | null>;
  const names = Object.keys(jobs).sort();
  return names.join(",") === "quality,test-shards" &&
      names.every((name) => jobs[name]?.result === "success")
    ? 0
    : 1;
}
export async function runNativeCiWrapper(
  io: NativeCiWrapperV1,
): Promise<number> {
  const commit = await io.git(["rev-parse", "HEAD"]);
  const tree = await io.git(["rev-parse", "HEAD^{tree}"]);
  const sources = {
    workflow: await io.git(["rev-parse", "HEAD:.github/workflows/ci.yml"]),
    harness: await io.git(["rev-parse", "HEAD:test-local.ts"]),
    emitter: await io.git(["rev-parse", "HEAD:ops/native-ci-proof.ts"]),
  };
  const status = await io.harness();
  if (status !== 0) return status;
  if (
    await io.git(["rev-parse", "HEAD"]) !== commit ||
    await io.git(["rev-parse", "HEAD^{tree}"]) !== tree
  ) throw new Error("native CI checkout changed");
  if (
    io.env("GITHUB_EVENT_NAME") !== "pull_request" ||
    io.env("GITHUB_REPOSITORY") !== "ubiquity-sentinel/sentinel"
  ) return 0;
  const event = JSON.parse(
    await io.readEvent(io.env("GITHUB_EVENT_PATH") ?? ""),
  );
  const proof: NativeCiProofV1 = {
    version: "v1",
    repository: "ubiquity-sentinel/sentinel",
    repositoryId: event.repository.id,
    runId: Number(io.env("GITHUB_RUN_ID")),
    attempt: Number(io.env("GITHUB_RUN_ATTEMPT")),
    job: "test-local",
    pr: event.number,
    headRef: event.pull_request.head.ref,
    head: event.pull_request.head.sha,
    base: event.pull_request.base.sha,
    testedCommit: commit as NativeCiProofV1["testedCommit"],
    testedTree: tree as NativeCiProofV1["testedTree"],
    workflowSource: io.env(
      "GITHUB_WORKFLOW_SHA",
    ) as NativeCiProofV1["workflowSource"],
    sources: sources as NativeCiProofV1["sources"],
  };
  // Only the full harness or its complete successful CI partition can emit this carrier.
  io.emit(`${NATIVE_CI_MARKER}${JSON.stringify(proof)}`);
  return 0;
}
if (import.meta.main) {
  const aggregate = Deno.args.length === 1 && Deno.args[0] === "--aggregate";
  if (Deno.args.length > 0 && !aggregate) {
    throw new Error("unknown native CI wrapper arguments");
  }
  const git = async (args: string[]) => {
    const r = await new Deno.Command("git", {
      args: ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", ...args],
      clearEnv: true,
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!r.success) throw new Error("native CI Git identity unavailable");
    return new TextDecoder().decode(r.stdout).trim();
  };
  const code = await runNativeCiWrapper({
    env: (name) => Deno.env.get(name),
    readEvent: (path) => Deno.readTextFile(path),
    git,
    harness: async () => {
      if (aggregate) {
        return nativeCiAggregateStatus(
          JSON.parse(Deno.env.get("SENTINEL_CI_RESULTS") ?? "null"),
        );
      }
      return (await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-env=PATH",
          "--allow-run=deno,git",
          "--allow-write",
          "test-local.ts",
        ],
        stdout: "inherit",
        stderr: "inherit",
      }).spawn().status).code;
    },
    emit: (line) => console.log(line),
  });
  Deno.exit(code);
}
