import { SystemClock } from "../contracts/ports.ts";
import type { Clock } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { FixtureResolverV1, ReplayPolicyV1 } from "./fixture.ts";
import { DenoReplayRuntime } from "./runtime.ts";
import type { ReplayRuntimeV1 } from "./runtime.ts";
import { validateReplayIsolationCapability } from "./isolation-capability.ts";
import type { ReplayIsolationCapabilityV1 } from "./isolation-capability.ts";

/** Trusted, read-only source of the repository to validate. */
export type ReplaySourceV1 =
  | { kind: "local"; path: string }
  | { kind: "remote"; url: string };

export interface ReplayPortOptions {
  /** The complete trusted repository configuration (frozen contract). */
  config: RepositoryConfigV1;
  /** Explicit source the checkout is cloned from (never guessed). */
  source: ReplaySourceV1;
  /** Scratch directory for disposable per-run clones and homes. */
  scratchDir: string;
  /** Injected trusted sanitized-fixture resolver. */
  fixtures: FixtureResolverV1;
  /** Trusted bundle/test policy (scopes, bounds, proof parser). */
  policy: ReplayPolicyV1;
  /**
   * Trusted restricted-execution capability; required. It must carry the
   * descriptive v1 attestation AND the callable `run` boundary, because a
   * target-controlled command may read workstation files even with clearEnv.
   */
  isolation: ReplayIsolationCapabilityV1;
  /**
   * Process runtime for TRUSTED Git clone/checkout/SHA operations only. The
   * configured target command never uses it: it runs through the captured
   * isolation `run` boundary. Defaults to the concrete DenoReplayRuntime.
   */
  runtime?: ReplayRuntimeV1;
  /** Clock for run timestamps; defaults to SystemClock. */
  clock?: Clock;
}

const LOCAL_SOURCE_RE = /^https?:\/\/[^\s/@]+(?::\d+)?(?:\/[^\s]*)?$/;
const FILE_SOURCE_RE = /^file:\/\/[^\s/@]+(?:\/[^\s]*)?$/;

export function initializeReplayPort(options: ReplayPortOptions) {
  // Whole-capability validation BEFORE any side effect: the descriptive
  // attestation AND the callable runner must both be present. The runner is
  // captured once and receiver-bound; a boolean-only attestation, a later
  // mutation or a changing/hostile accessor can never become the executor.
  const isolation = validateReplayIsolationCapability(options.isolation);
  if (isolation === null) {
    throw new TypeError(
      "ReplayPort requires an injected trusted isolation capability with " +
        "a callable restricted-execution runner (clearEnv is not a " +
        "sandbox; target-controlled commands need the restricted host)",
    );
  }
  if (options.source.kind === "local") {
    if (
      typeof options.source.path !== "string" ||
      !options.source.path.startsWith("/")
    ) {
      throw new TypeError(
        "ReplayPort local source must be an absolute path (read-only source)",
      );
    }
  } else if (options.source.kind === "remote") {
    if (
      typeof options.source.url !== "string" ||
      (!LOCAL_SOURCE_RE.test(options.source.url) &&
        !FILE_SOURCE_RE.test(options.source.url))
    ) {
      throw new TypeError(
        "ReplayPort remote source must be an http(s)/file URL without userinfo",
      );
    }
  } else {
    throw new TypeError("ReplayPort source must be local or remote");
  }
  for (const scope of options.policy.bundleScopes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(scope)) {
      throw new TypeError(
        "ReplayPort policy bundle scopes must be relative scopes with a " +
          'trailing slash (e.g. "tests/")',
      );
    }
  }
  const path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
  const runtime = options.runtime ?? new DenoReplayRuntime(path);
  const clock = options.clock ?? new SystemClock();
  return { isolation, path, runtime, clock };
}
