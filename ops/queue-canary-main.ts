/** Manual trusted-job entrypoint. No arguments, state writer, shell, or model. */
import { portOk } from "../src/contracts/ports.ts";
import {
  fetchHttpTransport,
  type HttpTransportV1,
} from "../src/github/http.ts";
import { canaryCooldown, CanaryGitHub } from "./queue-canary-github.ts";
import {
  CANARY_GRANTS,
  CANARY_REPOSITORY,
  type CanaryAction,
} from "./queue-canary-pins.ts";
import { type CanaryEvidence, runQueueCanary } from "./queue-canary.ts";

/** Sensitive/hostile free text is omitted, not silently treated as exact evidence. */
export function sanitizedCanaryArtifact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 4096 ||
        [...value].some((char) => {
          const code = char.codePointAt(0)!;
          return code <= 31 || code === 127 ||
            (code >= 0x202a && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069);
        }) ||
        /(?:gh[psuor]_[A-Za-z0-9_]{12,}|github_pat_|Bearer\s|-----BEGIN|(?:token|secret|password)\s*[=:])/i
          .test(value)
      ? { omitted: "unsafe_text" }
      : value;
  }
  if (
    value === null || typeof value === "number" || typeof value === "boolean"
  ) return value;
  if (Array.isArray(value)) return value.map(sanitizedCanaryArtifact);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, item],
      ) => [key, sanitizedCanaryArtifact(item)]),
    );
  }
  return null;
}

export function canaryExitCode(
  evidence: Pick<CanaryEvidence, "status">,
): number {
  return evidence.status === "observed" || evidence.status === "submitted"
    ? 0
    : 1;
}

export async function queueCanaryMain(): Promise<number> {
  const env = (name: string) => Deno.env.get(name) ?? "";
  const token = env("SENTINEL_SUPERVISOR_TOKEN"),
    hostReadToken = env("GITHUB_TOKEN");
  if (!token || !hostReadToken || Deno.args.length !== 0) return 2;
  const until = Date.now() + 285_000;
  const nativeHttp = fetchHttpTransport();
  const http: HttpTransportV1 = async (request) => {
    const remaining = until - Date.now();
    if (remaining <= 0 || !request.url.startsWith("https://api.github.com/")) {
      throw new Error("canary_deadline_or_scope");
    }
    return await nativeHttp({
      ...request,
      deadlineMs: Math.min(30_000, request.deadlineMs ?? 30_000, remaining),
      redirect: "error",
    });
  };
  const port = new CanaryGitHub({
    repository: CANARY_REPOSITORY,
    apiBaseUrl: "https://api.github.com",
    http,
    auth: {
      authorizationHeader: () => Promise.resolve(portOk(`Bearer ${token}`)),
    },
    cooldownGate: canaryCooldown(),
    clock: { now: Date.now },
    requestDeadlineMs: 30_000,
    maxPages: 10,
    maxItems: 1000,
  }, hostReadToken);
  let outputWritten = false;
  const retain = async (evidence: CanaryEvidence) => {
    await Deno.mkdir("artifacts/queue-canary", { recursive: true });
    await Deno.writeTextFile(
      "artifacts/queue-canary/evidence.next.json",
      JSON.stringify(sanitizedCanaryArtifact(evidence), null, 2) + "\n",
    );
    await Deno.rename(
      "artifacts/queue-canary/evidence.next.json",
      "artifacts/queue-canary/evidence.json",
    );
    if (!outputWritten) {
      await Deno.writeTextFile(
        env("GITHUB_OUTPUT"),
        `request_digest=${evidence.requestDigest}\n`,
        { append: true },
      );
      outputWritten = true;
    }
  };
  const result = await runQueueCanary({
    host: {
      repository: env("GITHUB_REPOSITORY"),
      ref: env("GITHUB_REF"),
      sha: env("GITHUB_SHA"),
      workflowSha: env("GITHUB_WORKFLOW_SHA"),
      expectedSha: env("CANARY_EXPECTED_SOURCE_SHA"),
      runId: Number(env("GITHUB_RUN_ID")),
      attempt: Number(env("GITHUB_RUN_ATTEMPT")),
      event: env("GITHUB_EVENT_NAME"),
      action: env("CANARY_ACTION") as CanaryAction,
      bindingDigest: env("CANARY_BINDING_DIGEST"),
      mintedAppSlug: env("CANARY_MINTED_APP_SLUG"),
      mintedInstallationId: Number(env("CANARY_MINTED_INSTALLATION_ID")),
    },
    grants: CANARY_GRANTS,
    port,
    now: Date.now,
    retain,
  });
  // Closed vocabulary only. Native error strings and credentials never reach logs.
  console.log(`queue-canary:${result.status}:${result.reason}`);
  return canaryExitCode(result);
}

if (import.meta.main) {
  try {
    Deno.exit(await queueCanaryMain());
  } catch {
    console.error("queue-canary:unavailable");
    Deno.exit(1);
  }
}
