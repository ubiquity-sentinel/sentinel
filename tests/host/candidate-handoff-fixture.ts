/** Shared credential-free hosted test fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { FakeModel } from "../repair/helpers.ts";
import { gitRun, T0 } from "../state/helpers.ts";
import { createLocalRepositoryConfig } from "../../src/host/local.ts";
import type { PreservationRefV1 } from "./candidate-handoff-fault-fixture.ts";

const HERE = new URL(import.meta.url);

if (HERE.protocol !== "file:") throw new Error("expected a file: test module");

export const ROOT = decodeURIComponent(
  new URL("../..", import.meta.url).pathname,
).replace(/\/$/, "");

export const WORKER_PATH = `${ROOT}/tests/host/candidate-handoff-worker.ts`;

export const TRUSTED_PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";

export const REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

export const ISSUE_NUMBER = 48;

export const PR_NUMBER = 51;

export const BASE_BRANCH = "development";

export const TRUSTED_AUTHOR = "sentinel[bot]";

export const TRUSTED_REVIEWER = "chatgpt-codex-connector[bot]";

export const PRODUCER_BRANCH = "sentinel-producer";

export const NOW = T0 + 2000;

/** The tiny Git fixture protects its retained file; full policy coverage lives in snapshot tests. */
export function handoffRepositoryConfig() {
  return { ...createLocalRepositoryConfig(), protectedPaths: ["shared.txt"] };
}

export function gitEnv(home: string): Record<string, string> {
  return {
    PATH: TRUSTED_PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-candidate-handoff-test",
    GIT_AUTHOR_EMAIL: "sentinel-candidate-handoff-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-candidate-handoff-test",
    GIT_COMMITTER_EMAIL: "sentinel-candidate-handoff-test@localhost",
  };
}

export function expectOk(result: { ok: boolean }, message: string): void {
  assert.ok(result.ok, message);
}

export async function head(
  cwd: string,
  env: Record<string, string>,
): Promise<GitSha> {
  const read = await gitRun(cwd, ["rev-parse", "HEAD"], env);
  assert.ok(read.ok, "fixture rev-parse failed");
  return read.stdout.trim() as GitSha;
}

export async function remoteRef(
  gitDir: string,
  env: Record<string, string>,
  ref: string,
): Promise<GitSha | null> {
  const read = await gitRun(gitDir, [
    "--git-dir",
    gitDir,
    "rev-parse",
    "--verify",
    "--quiet",
    ref,
  ], env);
  return read.ok ? read.stdout.trim() as GitSha : null;
}

export async function hasObject(
  repo: string,
  env: Record<string, string>,
  sha: GitSha,
): Promise<boolean> {
  return (await gitRun(repo, ["cat-file", "-e", `${sha}^{commit}`], env)).ok;
}

/** Actual retained candidate refs on the bare remote, read without writing. */
export async function retainedCandidateRef(
  gitDir: string,
  env: Record<string, string>,
  expected: GitSha,
): Promise<string | null> {
  const read = await gitRun(gitDir, [
    "--git-dir",
    gitDir,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads/sentinel-candidates/",
  ], env);
  if (!read.ok) return null;
  for (const line of read.stdout.split("\n")) {
    const [ref, sha] = line.trim().split(/\s+/);
    if (ref === undefined || sha === undefined) continue;
    if (!/^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/.test(ref)) {
      continue;
    }
    if (sha === expected) return ref;
  }
  return null;
}

/** One fake external boundary: produce real H1, import it, move the base. */
export class ProducerModel implements ImplementationPort {
  calls = 0;
  constructor(private readonly produce: () => Promise<GitSha>) {}
  async runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    this.calls += 1;
    // A second implementation start is never part of this handoff: fail before
    // any further candidate could be produced.
    if (this.calls > 1) {
      throw new Error(
        "ProducerModel: a second implementation call is not permitted",
      );
    }
    const head = await this.produce();
    // The existing valid FakeModel receipt helper is the trust boundary, and
    // the receipt's changed path must match the real H1 Git change.
    return await new FakeModel({ head, changedPaths: ["candidate.txt"] })
      .runModel(request);
  }
}

export function expectedOperationRefOf(
  refs: readonly PreservationRefV1[],
  sha: GitSha,
): string | undefined {
  return refs.find((entry) => entry.sha === sha)?.ref;
}
