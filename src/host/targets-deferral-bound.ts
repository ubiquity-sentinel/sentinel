/**
 * At most one green deferral in a row for the ordinary serial pass
 * (actions-targets-deferral.ts). A pass whose every target read failed
 * transiently defers only when the immediately previous execution provably
 * did not: its settlement (`hostedRuntimes[0].lastExecutionProof`, recorded
 * by the supervisor before this execution started) is a run proof, and that
 * exact repair job's log, read with the job's native token through the
 * existing bounded signed-log reader and bound to the settled `logDigest`,
 * names no `sentinel_targets_deferral` line. Every other answer (no
 * settlement, a `not_started` settlement, an unreadable or different log, or
 * any line naming the deferral kind, parsed or not) keeps the pass red.
 *
 * The launcher re-emits the line for a red pass too, so after one green
 * deferral every following unavailable pass stays red until a pass reads its
 * targets again. No field is persisted: the settlement and its log are the
 * existing evidence. The read is read-only: a rate limit it meets fails the
 * read and is never recorded.
 */
import { HOSTED_CONTROLLER_SELF } from "../contracts/hosted-controller-deployment.ts";
import type { HostedExecutionSettlementV1 } from "../contracts/hosted-supervisor.ts";
import {
  type Clock,
  type GitHubCooldownGateV1,
  portError,
  portOk,
  type PortResultV1,
} from "../contracts/ports.ts";
import { GitHubApiClient } from "../github/client.ts";
import { sha256Hex } from "../github/client-hosted-revision-wire.ts";
import { createDeadline, type HttpTransportV1 } from "../github/http.ts";
import { TARGETS_DEFERRAL_KIND } from "../repair/targets-deferral-line.ts";

/** Whole read bound for the previous job's log (API redirect plus blob). */
const PREVIOUS_LOG_READ_MS = 30_000;

/** Any line naming the deferral kind, whether or not it parses. */
const NAMES_DEFERRAL = new RegExp(`"kind"\\s*:\\s*"${TARGETS_DEFERRAL_KIND}"`);

/** Reads one settled repair job's log of the hosted controller repository. */
export type PreviousPassLogReaderV1 = (
  jobId: number,
) => Promise<PortResultV1<string>>;

/** True only when the previous execution provably did not defer. */
export async function previousPassAllowsDeferralV1(input: {
  readonly proof: HostedExecutionSettlementV1 | null;
  readonly readLog: PreviousPassLogReaderV1;
}): Promise<boolean> {
  const proof = input.proof;
  if (proof === null || proof.outcome === "not_started") return false;
  try {
    const log = await input.readLog(proof.jobId);
    if (!log.ok || await sha256Hex(log.value) !== proof.logDigest) {
      return false;
    }
    return !NAMES_DEFERRAL.test(log.value);
  } catch {
    return false;
  }
}

class PreviousPassLogClient extends GitHubApiClient {
  async readSettledJobLog(jobId: number): Promise<PortResultV1<string>> {
    if (
      !this.isHostedSelfScope() || !Number.isSafeInteger(jobId) || jobId <= 0
    ) return portError("invalid", "previous pass log scope is invalid");
    const deadline = createDeadline(PREVIOUS_LOG_READ_MS);
    try {
      return await this.readHostedRuntimeLog(jobId, deadline);
    } catch {
      return portError("unavailable", "previous pass log is unavailable");
    } finally {
      deadline.dispose();
    }
  }
}

/** The native-token reader of the hosted controller's settled job logs. */
export function nativeJobLogReaderV1(input: {
  readonly token: string;
  readonly http: HttpTransportV1;
  readonly clock: Clock;
  /** The run's durable cooldown still gates the read. */
  readonly gate: Pick<GitHubCooldownGateV1, "beforeRequest">;
}): PreviousPassLogReaderV1 {
  const client = new PreviousPassLogClient({
    repository: { ...HOSTED_CONTROLLER_SELF },
    apiBaseUrl: "https://api.github.com",
    http: input.http,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    cooldownGate: {
      beforeRequest: (scope) => input.gate.beforeRequest(scope),
      recordRateLimit: () =>
        Promise.resolve(
          portError("rate_limited", "previous pass log read was rate limited"),
        ),
    },
    clock: input.clock,
  });
  return (jobId) => client.readSettledJobLog(jobId);
}
