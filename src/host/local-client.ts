import { GATEWAY_PROVIDER, type ModelRouteV1 } from "./model-route.ts";
import type { CodexSessionV1 } from "../repair/codex-transport.ts";
import {
  DEFAULT_PROVIDER_NAME,
  DEFAULT_UOS_BASE_URL,
  PROVIDER_NAME_PATTERN,
  STATIC_LOCAL_PROVIDER,
} from "./local-policy.ts";
import {
  dirnamePath,
  ensurePrivateDir,
  joinPath,
  pathExistsSync,
  writePrivateFile,
} from "./local-io.ts";

/** Inputs of one isolated Codex client configuration. */
export interface LocalCodexConfigInputV1 {
  profile: "sentinel-local" | "sentinel-review";
  /** Private model token file read by the app-server auth command. */
  tokenFile: string;
  /** HOME of shell commands: the isolated checkout. */
  shellHome: string;
  shellPath: string;
  shellTmpDir: string;
  shellDenoDir: string;
  /** Exact executable launched by the trusted host; sandbox helpers must be
   * able to execute this path when loading project instructions. */
  codexExecutable: string;
  codexDistributionDir: string;
  denoExecutable: string;
  /** Exact extra writable grants outside the checkout (empty for review). */
  writeGrants: string[];
  /** Trusted provider endpoint; local callers use the loopback default. */
  baseUrl?: string;
  /**
   * Trusted route provider name used for `model_provider` and the
   * `[model_providers.<name>]` block. Defaults to the primary gateway provider
   * (`uos`); a route-selected fallback names its own provider so the client
   * config and the submitted thread provider always agree.
   */
  providerName?: string;
}

/**
 * Installed CommandLineTools Git directory. It precedes `/usr/bin` in the model
 * shell PATH when present, avoiding the macOS xcrun shim.
 */
const COMMAND_LINE_TOOLS_BIN = "/Library/Developer/CommandLineTools/usr/bin";

/** Read-only Git system configuration of that exact installed Git. */
const COMMAND_LINE_TOOLS_GIT_CORE =
  "/Library/Developer/CommandLineTools/usr/share/git-core";

/**
 * The one real Bun executable the hosted supervisor installs for Bun-only
 * targets (`.github/workflows/supervisor.yml`). The sandbox reads exactly this
 * file instead of relying on the `:minimal` platform set to cover it; a host
 * without it simply has no such file.
 */
export const SANDBOX_BUN_EXECUTABLE = "/usr/local/bin/bun";

/**
 * Render the per-client Codex configuration: the route's provider over its
 * configured endpoint, top-level approval/login/permission defaults, the proved
 * flat filesystem and network permission tables (relative grants live under
 * `:workspace_roots`) and a fixed minimal environment. Pure text; no token
 * value is ever included. `wire_api` stays `"responses"` for every provider.
 */
export function renderLocalCodexConfig(input: LocalCodexConfigInputV1): string {
  const profile = input.profile;
  const providerName = input.providerName ?? DEFAULT_PROVIDER_NAME;
  if (!PROVIDER_NAME_PATTERN.test(providerName)) {
    throw new Error(STATIC_LOCAL_PROVIDER);
  }
  const lines = [
    "# Sentinel local host client config (generated; do not edit).",
    'approval_policy = "never"',
    "allow_login_shell = false",
    `default_permissions = ${toml(profile)}`,
    `model_provider = ${toml(providerName)}`,
    "",
    `[model_providers.${providerName}]`,
    `name = ${toml(providerName)}`,
    `base_url = "${input.baseUrl ?? DEFAULT_UOS_BASE_URL}"`,
    'wire_api = "responses"',
    "",
    `[model_providers.${providerName}.auth]`,
    'command = "/bin/cat"',
    `args = [${toml(input.tokenFile)}]`,
    "",
    "[features]",
    "apps = false",
    "multi_agent = false",
    "plugins = false",
    "web_search = false",
    "",
    `[permissions.${profile}.filesystem]`,
    '":minimal" = "read"',
    `${toml(COMMAND_LINE_TOOLS_GIT_CORE)} = "read"`,
    `${toml(COMMAND_LINE_TOOLS_BIN)} = "read"`,
    `${toml(input.codexExecutable)} = "read"`,
    `${toml(input.codexDistributionDir)} = "read"`,
    `${toml(input.denoExecutable)} = "read"`,
    `${toml(SANDBOX_BUN_EXECUTABLE)} = "read"`,
  ];
  if (profile === "sentinel-local") {
    for (const grant of input.writeGrants) {
      lines.push(`${toml(grant)} = "write"`);
    }
  }
  lines.push(
    "",
    `[permissions.${profile}.filesystem.":workspace_roots"]`,
  );
  if (profile === "sentinel-local") {
    lines.push(
      '"." = "write"',
      '".git" = "read"',
      '".codex" = "read"',
    );
  } else {
    lines.push('"." = "read"');
  }
  lines.push(
    "",
    `[permissions.${profile}.network]`,
    "enabled = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "",
    "[shell_environment_policy.set]",
    `PATH = ${toml(localClientShellPath(input.shellPath))}`,
    `HOME = ${toml(input.shellHome)}`,
    `TMPDIR = ${toml(input.shellTmpDir)}`,
    `DENO_DIR = ${toml(input.shellDenoDir)}`,
    // HOME is the checkout, where Bun would otherwise keep its caches: the
    // transpiler cache is off and the install cache is the task's private
    // temp directory, so no Bun cache file ever lands in a candidate.
    'BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0"',
    `BUN_INSTALL_CACHE_DIR = ${toml(input.shellTmpDir)}`,
    "",
  );
  return lines.join("\n");
}

/** Write the isolated client home, token file and config for one task. */
export async function ensureTaskClient(input: {
  clientHome: string;
  tmpDir: string;
  denoDir: string;
  checkout: string;
  /** The route's key, written to the private client token file. */
  token: string;
  codexExecutable: string;
  denoExecutable: string;
  trustedPath: string;
  /**
   * Trusted route selection: the generated client config names this route's
   * provider and endpoint so the app-server and the submitted thread provider
   * always agree. Omitted callers keep the local gateway default.
   */
  route?: ModelRouteV1;
  /**
   * Explicit endpoint override. The startup preflight uses it to keep its
   * non-routable dummy endpoint (no model call is ever made there); when
   * omitted the route's own base URL is written.
   */
  baseUrl?: string;
}): Promise<void> {
  await ensurePrivateDir(input.clientHome);
  await ensurePrivateDir(input.tmpDir);
  await ensurePrivateDir(input.denoDir);
  const tokenFile = joinPath(input.clientHome, "model.token");
  await writePrivateFile(tokenFile, input.token);
  await writePrivateFile(
    joinPath(input.clientHome, "config.toml"),
    renderLocalCodexConfig({
      profile: "sentinel-local",
      tokenFile,
      shellHome: input.checkout,
      shellPath: input.trustedPath,
      shellTmpDir: input.tmpDir,
      shellDenoDir: input.denoDir,
      codexExecutable: input.codexExecutable,
      codexDistributionDir: codexDistributionDir(input.codexExecutable),
      denoExecutable: input.denoExecutable,
      writeGrants: [input.tmpDir, input.denoDir],
      baseUrl: input.baseUrl ?? input.route?.baseUrl,
      providerName: input.route?.provider,
    }),
  );
}

/**
 * Isolated read-only review client home, token file and profile config.
 *
 * The review client is ALWAYS bound to the gateway provider: the structured
 * reviewer submits through `GATEWAY_PROVIDER` with the dedicated review model,
 * so the generated config names the gateway provider and never follows the
 * implementation route (a DeepSeek-direct implementation route must not pair
 * the gateway-only review model with the DeepSeek endpoint). Callers pass the
 * gateway token and, for the hosted path, the gateway endpoint override;
 * omitted callers keep the local loopback gateway default.
 */
export async function ensureReviewClient(input: {
  reviewCheckout: string;
  reviewClientHome: string;
  reviewTmpDir: string;
  reviewDenoDir: string;
  /** The gateway token, written to the private client token file. */
  token: string;
  codexExecutable: string;
  denoExecutable: string;
  trustedPath: string;
  /** Explicit endpoint override; omitted callers keep the loopback default. */
  baseUrl?: string;
}): Promise<void> {
  await ensurePrivateDir(input.reviewCheckout);
  await ensurePrivateDir(input.reviewClientHome);
  await ensurePrivateDir(input.reviewTmpDir);
  await ensurePrivateDir(input.reviewDenoDir);
  const tokenFile = joinPath(input.reviewClientHome, "model.token");
  await writePrivateFile(tokenFile, input.token);
  await writePrivateFile(
    joinPath(input.reviewClientHome, "config.toml"),
    renderLocalCodexConfig({
      profile: "sentinel-review",
      tokenFile,
      shellHome: input.reviewCheckout,
      shellPath: input.trustedPath,
      shellTmpDir: input.reviewTmpDir,
      shellDenoDir: input.reviewDenoDir,
      codexExecutable: input.codexExecutable,
      codexDistributionDir: codexDistributionDir(input.codexExecutable),
      denoExecutable: input.denoExecutable,
      writeGrants: [],
      baseUrl: input.baseUrl,
      providerName: GATEWAY_PROVIDER,
    }),
  );
}

/** Minimal child environment: no GitHub, UOS or host credentials. */
export function codexChildEnv(
  clientHome: string,
  tmpDir: string,
  denoDir: string,
  trustedPath: string,
): Record<string, string> {
  return {
    PATH: trustedPath,
    HOME: clientHome,
    CODEX_HOME: clientHome,
    TMPDIR: tmpDir,
    DENO_DIR: denoDir,
  };
}

// ---------------------------------------------------------------------------
// Session settlement tracking
// ---------------------------------------------------------------------------

/** Every session this run opened, so close/settlement is verified once. */
export class LocalSessionTracker {
  private readonly sessions = new Set<CodexSessionV1>();

  open<Session extends CodexSessionV1>(factory: () => Session): Session {
    const session = factory();
    this.sessions.add(session);
    return session;
  }

  /** Close every owned session and prove settlement; never throws. */
  async settleAll(): Promise<boolean> {
    let settled = true;
    for (const session of [...this.sessions]) {
      try {
        await session.close();
      } catch {
        settled = false;
      }
      try {
        if (session.isSettled?.() === false) settled = false;
      } catch {
        settled = false;
      }
    }
    return settled;
  }
}

/** Installed Codex distribution directory derived from the executable path. */
function codexDistributionDir(codexExecutable: string): string {
  // npm's pinned @openai/codex package resolves its launcher through a
  // node_modules tree rather than the owner's ~/.codex/packages layout. The
  // trusted global node_modules root is the smallest read-only grant that
  // lets the launcher load its optional platform binary and package files.
  const nodeModules = "/node_modules/";
  const nodeModulesIndex = codexExecutable.indexOf(nodeModules);
  if (nodeModulesIndex >= 0) {
    return codexExecutable.slice(0, nodeModulesIndex + nodeModules.length - 1);
  }
  return joinPath(
    dirnamePath(dirnamePath(codexExecutable)),
    "packages",
    "standalone",
  );
}

/**
 * Model shell PATH: when this host actually has the installed CommandLineTools
 * Git executable, its directory precedes `/usr/bin`, which on macOS is only an
 * xcrun shim. The given PATH remains the fallback everywhere else.
 */
function localClientShellPath(trustedPath: string): string {
  if (!pathExistsSync(joinPath(COMMAND_LINE_TOOLS_BIN, "git"))) {
    return trustedPath;
  }
  const rest = trustedPath
    .split(":")
    .filter((dir) => dir !== COMMAND_LINE_TOOLS_BIN);
  return [COMMAND_LINE_TOOLS_BIN, ...rest].join(":");
}

function toml(value: string): string {
  return JSON.stringify(value);
}
