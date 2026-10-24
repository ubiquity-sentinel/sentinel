/** Restricted private-stdin boundary for the deterministic VPS release owner. */
import type { GitSha } from "../contracts/brands.ts";
import type {
  PortResultV1,
  ReleaseStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import { portError } from "../contracts/ports.ts";
import {
  parseVpsIdentity,
  type VpsIdentity,
} from "../contracts/vps-release-wire.ts";
import {
  composeTrustedVpsReleaseHost,
  type TrustedVpsReleaseHostOptionsV1,
} from "./vps-release.ts";
import {
  runVpsReleaseEntrypoint,
  type VpsReleaseEntrypointDepsV1,
} from "../release-main.ts";
import {
  createReleaseStateStore,
  DenoGitRunner,
  type GitRunnerV1,
} from "../state/mod.ts";
import { githubGitAuthEnv } from "./local-github-auth.ts";
import type { VpsReleaseRecordV1 } from "../contracts/vps-release.ts";

export const RELEASE_BRIDGE_ROOT = "/usr/local/lib/sentinel-release-bridge";
export const RELEASE_BRIDGE_CONFIG = `${RELEASE_BRIDGE_ROOT}/config.json`;
export const RELEASE_BRIDGE_CONFIG_DIGEST =
  `${RELEASE_BRIDGE_ROOT}/config.sha256`;
export const RELEASE_BRIDGE_CAPABILITIES =
  `${RELEASE_BRIDGE_ROOT}/capabilities.ts`;
export const RELEASE_BRIDGE_STATE_REPOSITORY =
  "https://github.com/ubiquity-sentinel/sentinel.git";
export const RELEASE_BRIDGE_STATE_REF = "refs/heads/sentinel-state/release";
export const RELEASE_BRIDGE_INPUT_LIMIT = 32_768;
export const RELEASE_BRIDGE_ISSUER =
  "https://token.actions.githubusercontent.com";
export const RELEASE_BRIDGE_JWKS = `${RELEASE_BRIDGE_ISSUER}/.well-known/jwks`;
export const RELEASE_BRIDGE_AUDIENCE = "urn:uos:sentinel:vps-release-bridge:v1";
export const RELEASE_BRIDGE_PRIVATE_ROOT = "/var/lib/sentinel-release-bridge";
const API = "https://api.github.com/repos/ubiquity-sentinel/sentinel";
const REF = "refs/heads/sentinel-supervisor";
const ENVIRONMENT = "sentinel-release-bridge";
const WORKFLOW = ".github/workflows/release.yml";
const TARGET = "/home/codex/repos/ubiquity/ai.ubq.fi";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ReleaseBridgeCode =
  | "input_rejected"
  | "installation_rejected"
  | "setup_only"
  | "authentication_rejected"
  | "workflow_disabled"
  | "capability_unavailable"
  | "state_unavailable"
  | "owner_unavailable"
  | "replay_rejected"
  | "controller_unavailable";
class Refusal extends Error {
  constructor(readonly code: ReleaseBridgeCode) {
    super(code);
  }
}
function refuse(code: ReleaseBridgeCode): never {
  throw new Refusal(code);
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    refuse("input_rejected");
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) {
    refuse("input_rejected");
  }
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > max ||
    [...value].some((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  ) refuse("input_rejected");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    refuse("input_rejected");
  }
  return value;
}
function hex(value: unknown, length: number): string {
  const result = text(value, length);
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(result)) {
    refuse("input_rejected");
  }
  return result;
}
export type ReleaseBridgeExecution = {
  runId: number;
  runAttempt: number;
  jobId: number;
};
export type ReleaseBridgeInput = { version: "v1"; operation: "preflight" } | {
  version: "v1";
  operation: "run";
  execution: ReleaseBridgeExecution;
  oidcToken: string;
  nativeStateToken: string;
};
/** No target, revision, origin, argv, path, role or caller authority field exists. */
export function parseReleaseBridgeInput(bytes: Uint8Array): ReleaseBridgeInput {
  try {
    if (bytes.byteLength > RELEASE_BRIDGE_INPUT_LIMIT) refuse("input_rejected");
    const row = object(JSON.parse(decoder.decode(bytes)));
    if (row.version !== "v1") refuse("input_rejected");
    if (row.operation === "preflight") {
      keys(row, ["version", "operation"]);
      return { version: "v1", operation: "preflight" };
    }
    if (row.operation !== "run") refuse("input_rejected");
    keys(row, [
      "version",
      "operation",
      "execution",
      "oidcToken",
      "nativeStateToken",
    ]);
    const execution = object(row.execution);
    keys(execution, ["runId", "runAttempt", "jobId"]);
    return {
      version: "v1",
      operation: "run",
      execution: {
        runId: integer(execution.runId),
        runAttempt: integer(execution.runAttempt),
        jobId: integer(execution.jobId),
      },
      oidcToken: text(row.oidcToken, 24_576),
      nativeStateToken: text(row.nativeStateToken, 4_096),
    };
  } catch {
    return refuse("input_rejected");
  }
}
export async function readReleaseBridgeInput(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, 5_000);
  try {
    while (true) {
      const next = await reader.read();
      if (timedOut) refuse("input_rejected");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > RELEASE_BRIDGE_INPUT_LIMIT) refuse("input_rejected");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Root-owned installation data is separate from the untrusted stdin protocol. */
export interface ReleaseBridgeInstallation {
  version: "v1";
  kind: "vps_release_bridge_installation";
  activation: "setup_only" | "owner_activated";
  controller: {
    revision: GitSha;
    root: string;
    treeSha256: string;
    entrypointSha256: string;
  };
  driver: { root: string; identity: VpsIdentity; moduleSha256: string };
  source: {
    revision: GitSha;
    workflowId: number;
    workflowSha256: string;
    repositoryId: number;
    ownerId: number;
    subject: string;
    environment: typeof ENVIRONMENT;
  };
  targetInstallationId: number;
  capabilitiesSha256: string | null;
}
export function parseReleaseBridgeInstallation(
  value: unknown,
): ReleaseBridgeInstallation {
  try {
    const row = object(value);
    keys(row, [
      "version",
      "kind",
      "activation",
      "controller",
      "driver",
      "source",
      "targetInstallationId",
      "capabilitiesSha256",
    ]);
    if (
      row.version !== "v1" || row.kind !== "vps_release_bridge_installation" ||
      !["setup_only", "owner_activated"].includes(String(row.activation))
    ) refuse("installation_rejected");
    const controller = object(row.controller),
      driver = object(row.driver),
      source = object(row.source);
    keys(controller, ["revision", "root", "treeSha256", "entrypointSha256"]);
    keys(driver, ["root", "identity", "moduleSha256"]);
    keys(source, [
      "revision",
      "workflowId",
      "workflowSha256",
      "repositoryId",
      "ownerId",
      "subject",
      "environment",
    ]);
    const revision = hex(controller.revision, 40) as GitSha;
    const identity = parseVpsIdentity(driver.identity);
    if (
      controller.root !==
        `${RELEASE_BRIDGE_ROOT}/controller/releases/${revision}` ||
      driver.root !==
        `${RELEASE_BRIDGE_ROOT}/driver/releases/${identity.gitSha}`
    ) refuse("installation_rejected");
    const environment = text(source.environment, 100);
    if (environment !== ENVIRONMENT) refuse("installation_rejected");
    const subject = text(source.subject, 512);
    const repositoryId = integer(source.repositoryId),
      ownerId = integer(source.ownerId);
    const suffix = `environment:${ENVIRONMENT}`;
    if (
      ![
        `repo:ubiquity-sentinel/sentinel:${suffix}`,
        `repo:ubiquity-sentinel@${ownerId}/sentinel@${repositoryId}:${suffix}`,
      ].includes(subject)
    ) refuse("installation_rejected");
    return {
      version: "v1",
      kind: "vps_release_bridge_installation",
      activation: row.activation as ReleaseBridgeInstallation["activation"],
      controller: {
        revision,
        root: String(controller.root),
        treeSha256: hex(controller.treeSha256, 64),
        entrypointSha256: hex(controller.entrypointSha256, 64),
      },
      driver: {
        root: String(driver.root),
        identity,
        moduleSha256: hex(driver.moduleSha256, 64),
      },
      source: {
        revision: hex(source.revision, 40) as GitSha,
        workflowId: integer(source.workflowId),
        workflowSha256: hex(source.workflowSha256, 64),
        repositoryId,
        ownerId,
        subject,
        environment,
      },
      targetInstallationId: integer(row.targetInstallationId),
      capabilitiesSha256: row.capabilitiesSha256 === null
        ? null
        : hex(row.capabilitiesSha256, 64),
    };
  } catch {
    return refuse("installation_rejected");
  }
}
export async function bridgeSha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ].map((v) => v.toString(16).padStart(2, "0")).join("");
}
export function parseReleaseBridgeConfigDigest(bytes: Uint8Array): string {
  try {
    const value = decoder.decode(bytes);
    if (bytes.length > 65 || !/^[a-f0-9]{64}\n?$/.test(value)) {
      refuse("installation_rejected");
    }
    return value.slice(0, 64);
  } catch {
    return refuse("installation_rejected");
  }
}
/** Reject mutable/root-escaping installation paths before import or execution. */
export async function readRootPinnedBridgeFile(
  path: string,
  expected: string | null,
  limit = 65_536,
): Promise<Uint8Array> {
  if (
    !path.startsWith(`${RELEASE_BRIDGE_ROOT}/`) ||
    path.split("/").some((v) => v === "." || v === "..")
  ) refuse("installation_rejected");
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (let index = 0; index < parts.length; index++) {
    current += `/${parts[index]}`;
    const stat = await Deno.lstat(current);
    if (
      stat.isSymlink || stat.uid !== 0 || ((stat.mode ?? 0) & 0o022) !== 0 ||
      (index < parts.length - 1 && !stat.isDirectory)
    ) refuse("installation_rejected");
    if (index === parts.length - 1 && (!stat.isFile || stat.size > limit)) {
      refuse("installation_rejected");
    }
  }
  const bytes = await Deno.readFile(path);
  if (
    bytes.length > limit ||
    (expected !== null && await bridgeSha256(bytes) !== expected)
  ) refuse("installation_rejected");
  return bytes;
}

/** Same immutable-tree digest as the real driver loader, without evaluating modules. */
export async function verifyReleaseBridgeInstallation(
  pin: ReleaseBridgeInstallation,
): Promise<void> {
  for (
    const [root, expected] of [
      [pin.controller.root, pin.controller.treeSha256],
      [pin.driver.root, pin.driver.identity.immutableTreeSha256],
    ]
  ) {
    const entries: string[] = [];
    let count = 0, total = 0;
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > 32) refuse("installation_rejected");
      const names: string[] = [];
      for await (const entry of Deno.readDir(`${root}/${relative}`)) {
        if (++count > 10_000) refuse("installation_rejected");
        names.push(entry.name);
      }
      names.sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        const path = relative ? `${relative}/${name}` : name;
        const full = `${root}/${path}`,
          stat = await Deno.lstat(full),
          mode = (stat.mode ?? 0) & 0o777;
        if (stat.uid !== 0 || (mode & 0o022) !== 0 || stat.isSymlink) {
          refuse("installation_rejected");
        }
        if (stat.isDirectory) {
          entries.push(JSON.stringify([path, "directory", mode]));
          await walk(path, depth + 1);
        } else if (stat.isFile) {
          total += stat.size;
          if (stat.size > 16_777_216 || total > 536_870_912) {
            refuse("installation_rejected");
          }
          const bytes = await readRootPinnedBridgeFile(full, null, 16_777_216);
          entries.push(
            JSON.stringify([path, "file", mode, await bridgeSha256(bytes)]),
          );
        } else refuse("installation_rejected");
      }
    };
    await readRootPinnedBridgeFile(
      `${root}/ops/${
        root === pin.controller.root
          ? "vps-release-bridge"
          : "vps-release-driver"
      }.ts`,
      root === pin.controller.root
        ? pin.controller.entrypointSha256
        : pin.driver.moduleSha256,
    );
    await walk("", 0);
    if (await bridgeSha256(encoder.encode(entries.join("\n"))) !== expected) {
      refuse("installation_rejected");
    }
  }
}

async function responseBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (response.status !== 200 || response.body === null) {
    refuse("authentication_rejected");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) refuse("authentication_rejected");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function requestBytes(
  http: typeof fetch,
  url: string,
  token: string | null,
  limit = 65_536,
): Promise<Uint8Array> {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 5_000);
  try {
    return await responseBytes(
      await http(url, {
        method: "GET",
        redirect: "error",
        signal: abort.signal,
        headers: token === null ? { accept: "application/json" } : {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      }),
      limit,
    );
  } finally {
    clearTimeout(timer);
  }
}
function base64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) refuse("authentication_rejected");
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (v) => v.charCodeAt(0),
  );
}
export interface ReleaseBridgeAuthenticatedJob extends ReleaseBridgeExecution {
  checkRunId: number;
  replayDigest: string;
  expiresAt: number;
}
/** Public GitHub RS256 keys authenticate signed job claims; stdin never supplies keys. */
export async function authenticateReleaseBridgeJob(
  input: Extract<ReleaseBridgeInput, { operation: "run" }>,
  pin: ReleaseBridgeInstallation,
  http: typeof fetch,
  now: number,
): Promise<ReleaseBridgeAuthenticatedJob> {
  try {
    const segments = input.oidcToken.split(".");
    if (segments.length !== 3) refuse("authentication_rejected");
    const header = object(JSON.parse(decoder.decode(base64url(segments[0]))));
    keys(header, ["alg", "kid", "typ"]);
    if (header.alg !== "RS256" || header.typ !== "JWT") {
      refuse("authentication_rejected");
    }
    const kid = text(header.kid, 256);
    const jwks = object(
      JSON.parse(
        decoder.decode(await requestBytes(http, RELEASE_BRIDGE_JWKS, null)),
      ),
    );
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 16) {
      refuse("authentication_rejected");
    }
    const matches = jwks.keys.map(object).filter((key) =>
      key.kid === kid && key.kty === "RSA" && key.alg === "RS256" &&
      key.use === "sig"
    );
    if (matches.length !== 1) refuse("authentication_rejected");
    const jwk = matches[0];
    if (
      typeof jwk.n !== "string" || base64url(jwk.n).length < 256 ||
      typeof jwk.e !== "string"
    ) refuse("authentication_rejected");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        base64url(segments[2]),
        encoder.encode(`${segments[0]}.${segments[1]}`),
      )
    ) refuse("authentication_rejected");
    const claims = object(JSON.parse(decoder.decode(base64url(segments[1]))));
    const { source } = pin,
      seconds = Math.floor(now / 1_000),
      exp = integer(claims.exp),
      iat = integer(claims.iat),
      nbf = integer(claims.nbf);
    if (
      claims.iss !== RELEASE_BRIDGE_ISSUER ||
      claims.aud !== RELEASE_BRIDGE_AUDIENCE || claims.sub !== source.subject ||
      claims.repository !== "ubiquity-sentinel/sentinel" ||
      claims.repository_owner !== "ubiquity-sentinel" ||
      claims.repository_id !== String(source.repositoryId) ||
      claims.repository_owner_id !== String(source.ownerId) ||
      claims.ref !== REF || claims.ref_type !== "branch" ||
      claims.sha !== source.revision ||
      claims.workflow_sha !== source.revision ||
      claims.workflow_ref !== `ubiquity-sentinel/sentinel/${WORKFLOW}@${REF}` ||
      claims.workflow !== "sentinel-release" ||
      claims.job_workflow_ref !== undefined ||
      claims.job_workflow_sha !== undefined ||
      claims.event_name !== "workflow_dispatch" ||
      claims.runner_environment !== "github-hosted" ||
      claims.run_id !== String(input.execution.runId) ||
      claims.run_attempt !== String(input.execution.runAttempt) ||
      claims.environment !== ENVIRONMENT ||
      exp <= seconds || iat > seconds || nbf > seconds || exp <= iat ||
      exp - iat > 600 || seconds - iat > 300 || nbf > iat
    ) refuse("authentication_rejected");
    const checkRunId = typeof claims.check_run_id === "number"
      ? integer(claims.check_run_id)
      : integer(Number(text(claims.check_run_id, 20)));
    if (String(checkRunId) !== String(claims.check_run_id)) {
      refuse("authentication_rejected");
    }
    const jti = text(claims.jti, 256);
    const job = {
      ...input.execution,
      checkRunId,
      replayDigest: await bridgeSha256(
        encoder.encode(`${jti}\0${checkRunId}\0${input.execution.runAttempt}`),
      ),
      expiresAt: exp * 1_000,
    };
    await assertReleaseBridgeJobAlive(input.nativeStateToken, pin, job, http);
    const sourceBytes = await requestBytes(
      http,
      `${API}/contents/${WORKFLOW}?ref=${source.revision}`,
      input.nativeStateToken,
    );
    const contents = object(JSON.parse(decoder.decode(sourceBytes)));
    if (
      contents.type !== "file" || contents.path !== WORKFLOW ||
      contents.encoding !== "base64" || typeof contents.content !== "string" ||
      contents.content.length > 48_000
    ) refuse("authentication_rejected");
    const workflowBytes = Uint8Array.from(
      atob(contents.content.replaceAll("\n", "")),
      (v) => v.charCodeAt(0),
    );
    if (await bridgeSha256(workflowBytes) !== source.workflowSha256) {
      refuse("authentication_rejected");
    }
    return job;
  } catch (error) {
    if (error instanceof Refusal && error.code === "workflow_disabled") {
      throw error;
    }
    return refuse("authentication_rejected");
  }
}
/** Every effect rechecks the exact native owner; age or token shape proves nothing. */
export async function assertReleaseBridgeJobAlive(
  token: string,
  pin: ReleaseBridgeInstallation,
  job: ReleaseBridgeAuthenticatedJob,
  http: typeof fetch,
): Promise<void> {
  const read = async (path: string) =>
    object(
      JSON.parse(
        decoder.decode(await requestBytes(http, `${API}${path}`, token)),
      ),
    );
  const workflow = await read(`/actions/workflows/${pin.source.workflowId}`);
  if (workflow.state !== "active") refuse("workflow_disabled");
  if (
    workflow.id !== pin.source.workflowId || workflow.path !== WORKFLOW ||
    workflow.name !== "sentinel-release"
  ) refuse("authentication_rejected");
  const run = await read(
      `/actions/runs/${job.runId}/attempts/${job.runAttempt}`,
    ),
    repository = object(run.repository);
  if (
    run.id !== job.runId || run.run_attempt !== job.runAttempt ||
    run.workflow_id !== pin.source.workflowId ||
    run.head_sha !== pin.source.revision ||
    run.head_branch !== "sentinel-supervisor" ||
    run.event !== "workflow_dispatch" || run.status !== "in_progress" ||
    repository.id !== pin.source.repositoryId ||
    repository.full_name !== "ubiquity-sentinel/sentinel"
  ) refuse("authentication_rejected");
  const nativeJob = await read(`/actions/jobs/${job.jobId}`);
  if (
    nativeJob.id !== job.jobId || nativeJob.run_id !== job.runId ||
    nativeJob.run_attempt !== job.runAttempt ||
    nativeJob.head_sha !== pin.source.revision ||
    nativeJob.name !== "release" || nativeJob.status !== "in_progress" ||
    nativeJob.conclusion !== null ||
    nativeJob.check_run_url !== `${API}/check-runs/${job.checkRunId}`
  ) refuse("authentication_rejected");
}

export interface ReleaseBridgeCapabilities {
  /** Durable atomic one-use hash claim; never stores the JWT or native token. */
  claimReplay(digest: string, expiresAt: number): Promise<boolean>;
  /** Owner-authenticated exclusive target custody; absent/dead custody refuses. */
  acquireOwner(
    job: ReleaseBridgeAuthenticatedJob,
  ): Promise<{ release(): Promise<void> } | null>;
  /**
   * No `platform` substitute: the driver's command and journal runners are the
   * pinned tree's own (sentinel#161). `preparePayload`, when the owner supplies
   * one, reaches the pinned driver unchanged (sentinel#162).
   */
  host: Omit<
    TrustedVpsReleaseHostOptionsV1,
    | "stateRead"
    | "stateWrite"
    | "repository"
    | "environment"
    | "controllerSha"
    | "targetRoot"
    | "pinnedDriver"
    | "platform"
  >;
}
/** Existing clearEnv Git transport; header exists only inside trusted Git children. */
export function createNativeReleaseBridgeState(token: string, paths = {
  scratchDir: `${RELEASE_BRIDGE_PRIVATE_ROOT}/state`,
  gitHome: `${RELEASE_BRIDGE_PRIVATE_ROOT}/git-home`,
}, runner?: GitRunnerV1): StateReadView & ReleaseStateWriter {
  const store = createReleaseStateStore({
    remoteUrl: RELEASE_BRIDGE_STATE_REPOSITORY,
    scratchDir: paths.scratchDir,
    runner: runner ??
      new DenoGitRunner(
        paths.gitHome,
        githubGitAuthEnv(token, RELEASE_BRIDGE_STATE_REPOSITORY),
      ),
  });
  return {
    readRepair: () => store.readRepair(),
    readRelease: () => store.readRelease(),
    readReleaseAt: store.readReleaseAt?.bind(store),
    writeRelease: (snapshot, head) => store.writeRelease(snapshot, head),
  };
}
/** The execution bridge passes only this read-only native state view to its host. */
export function createReleaseBridgeStateReadView(
  state: StateReadView,
): StateReadView {
  return {
    readRepair: () => state.readRepair(),
    readRelease: () => state.readRelease(),
    readReleaseAt: state.readReleaseAt?.bind(state),
  };
}
export async function requireReleaseBridgeState(
  state: StateReadView & ReleaseStateWriter,
): Promise<void> {
  if (
    typeof state.readRelease !== "function" ||
    typeof state.readRepair !== "function" ||
    typeof state.writeRelease !== "function" || "writeRepair" in state
  ) refuse("capability_unavailable");
  const [repair, release] = await Promise.all([
    state.readRepair(),
    state.readRelease(),
  ]);
  if (
    !repair.ok || !release.ok || repair.value.status !== "found" ||
    release.value.status !== "found"
  ) refuse("state_unavailable");
}
/** A created replay reservation is conservative after interruption; no token is stored. */
export async function claimReleaseBridgeReplay(
  digest: string,
  expiresAt: number,
  root = `${RELEASE_BRIDGE_PRIVATE_ROOT}/replay`,
): Promise<boolean> {
  hex(digest, 64);
  integer(expiresAt);
  const stat = await Deno.lstat(root);
  if (
    !stat.isDirectory || stat.isSymlink || ((stat.mode ?? 0) & 0o077) !== 0 ||
    await Deno.realPath(root) !== root
  ) return false;
  let file: Deno.FsFile;
  try {
    file = await Deno.open(`${root}/${digest}.json`, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return false;
    throw error;
  }
  try {
    const bytes = encoder.encode(
      JSON.stringify({ version: "v1", digest, expiresAt }),
    );
    let offset = 0;
    while (offset < bytes.length) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
    const directory = await Deno.open(root, { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
    return true;
  } finally {
    file.close();
  }
}
export type ReleaseBridgeResult = {
  version: "v1";
  kind: "vps_release_bridge_result";
  status: "preflight" | "ran" | "refused";
  code: ReleaseBridgeCode | null;
  phase: VpsReleaseRecordV1["phase"] | null;
};
export const releaseBridgeFailure = (
  code: ReleaseBridgeCode,
): ReleaseBridgeResult => ({
  version: "v1",
  kind: "vps_release_bridge_result",
  status: "refused",
  code,
  phase: null,
});
/** Shared actual consumer boundary: guarded native effects feed the existing controller. */
export async function dispatchReleaseBridgeController(
  deps: VpsReleaseEntrypointDepsV1,
  job: ReleaseBridgeAuthenticatedJob,
  token: string,
  pin: ReleaseBridgeInstallation,
  http: typeof fetch,
): ReturnType<typeof runVpsReleaseEntrypoint> {
  if (
    deps.repository.owner !== "ubiquity" ||
    deps.repository.name !== "ai.ubq.fi" ||
    deps.repository.installationId !== pin.targetInstallationId ||
    deps.environment !== "production" ||
    deps.controllerSha !== pin.controller.revision ||
    deps.driverSha256 !== pin.driver.moduleSha256 ||
    "writeRepair" in deps.stateWrite
  ) return portError("invalid", "release bridge capability scope is rejected");
  const alive = () => assertReleaseBridgeJobAlive(token, pin, job, http);
  const originalWriter = deps.stateWrite;
  deps = {
    ...deps,
    stateWrite: {
      writeRelease: async (snapshot, head) => {
        try {
          await alive();
          return await originalWriter.writeRelease(snapshot, head);
        } catch {
          return portError(
            "unavailable",
            "release bridge owner is unavailable",
          );
        }
      },
    },
    port: { ...deps.port },
  };
  for (const method of ["prepare", "activate", "restore", "settle"] as const) {
    const original = deps.port[method].bind(deps.port);
    Object.assign(deps.port, {
      [method]: async (value: never): Promise<PortResultV1<unknown>> => {
        try {
          await alive();
          return await original(value);
        } catch {
          return portError(
            "unavailable",
            "release bridge owner is unavailable",
          );
        }
      },
    });
  }
  return await runVpsReleaseEntrypoint(deps);
}
/** Only this fixed composition can dispatch; caller text cannot select a controller. */
export async function runReleaseBridge(
  input: ReleaseBridgeInput,
  pin: ReleaseBridgeInstallation,
  capabilities: ReleaseBridgeCapabilities | null,
  http: typeof fetch = fetch,
): Promise<ReleaseBridgeResult> {
  let owner: { release(): Promise<void> } | null = null;
  try {
    if (input.operation === "preflight") {
      return {
        version: "v1",
        kind: "vps_release_bridge_result",
        status: "preflight",
        code: pin.activation === "setup_only" ? "setup_only" : null,
        phase: null,
      };
    }
    if (pin.activation !== "owner_activated") refuse("setup_only");
    if (
      capabilities === null || pin.capabilitiesSha256 === null ||
      "platform" in Object(capabilities.host)
    ) refuse("capability_unavailable");
    const job = await authenticateReleaseBridgeJob(
      input,
      pin,
      http,
      capabilities.host.clock.now(),
    );
    owner = await capabilities.acquireOwner(job);
    if (owner === null) refuse("owner_unavailable");
    const state = createNativeReleaseBridgeState(input.nativeStateToken);
    await requireReleaseBridgeState(state);
    if (!await capabilities.claimReplay(job.replayDigest, job.expiresAt)) {
      refuse("replay_rejected");
    }
    const options: TrustedVpsReleaseHostOptionsV1 = {
      ...capabilities.host,
      stateRead: createReleaseBridgeStateReadView(state),
      stateWrite: state,
      repository: {
        owner: "ubiquity",
        name: "ai.ubq.fi",
        installationId: pin.targetInstallationId,
      },
      environment: "production",
      controllerSha: pin.controller.revision,
      targetRoot: TARGET,
      pinnedDriver: {
        releaseRoot: pin.driver.root,
        identity: pin.driver.identity,
        moduleSha256: pin.driver.moduleSha256,
      },
    };
    const composed = await composeTrustedVpsReleaseHost(options);
    if (!composed.ok) refuse("capability_unavailable");
    const result = await dispatchReleaseBridgeController(
      composed.value,
      job,
      input.nativeStateToken,
      pin,
      http,
    );
    if (!result.ok) refuse("controller_unavailable");
    return {
      version: "v1",
      kind: "vps_release_bridge_result",
      status: "ran",
      code: null,
      phase: result.value.phase,
    };
  } catch (error) {
    return releaseBridgeFailure(
      error instanceof Refusal ? error.code : "capability_unavailable",
    );
  } finally {
    if (owner !== null) await owner.release().catch(() => {});
  }
}
