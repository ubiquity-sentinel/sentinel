/** Authenticated native owner proof; job completion never supplies missing close evidence. */
import { canonicalStringify } from "../contracts/canonical.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { HOSTED_ACTIONS_CLOCK_TOLERANCE_MS } from "../contracts/hosted-supervisor.ts";
import { GitHubClientHostedExecution } from "./client-hosted-execution.ts";
import { parseHostedAttempt } from "./client-hosted-job-wire.ts";
import { HOSTED_EXECUTION_TERMINAL_LINE } from "./client-hosted-log-wire.ts";
import { HOSTED_EXECUTION_READ_DEADLINE_MS } from "./client-hosted-policy.ts";
import { sha256Hex } from "./client-hosted-revision-wire.ts";
import { createDeadline } from "./http.ts";
import { repoPath } from "./client-response.ts";
import {
  parseHostedReviewOwnerSettlement,
  parseReviewOwnerRegistration,
  sameReviewOwnerRegistration,
} from "./review-owner-evidence.ts";
import type {
  ReviewOwnerRegistrationV1,
  ReviewOwnerSettlementProofV1,
} from "./review-owner-evidence.ts";

const REFUSAL = "review owner native settlement unavailable";
const CARRIER_LOOKING = /"kind"\s*:\s*"hosted_review_owner_settled"/;

export abstract class GitHubClientReviewOwner
  extends GitHubClientHostedExecution {
  async readReviewOwnerSettlement(
    input: ReviewOwnerRegistrationV1,
  ): Promise<PortResultV1<ReviewOwnerSettlementProofV1 | null>> {
    if (!this.isHostedSelfScope()) return portError("invalid", REFUSAL);
    const deadline = createDeadline(HOSTED_EXECUTION_READ_DEADLINE_MS);
    try {
      const expected = parseReviewOwnerRegistration(input);
      const execution = expected.journal.ownerExecution!;
      const attempt = await this.actionsReleaseGet(
        `/repos/${
          repoPath(this.repository)
        }/actions/runs/${execution.runId}/attempts/${execution.runAttempt}`,
        {},
        deadline,
      );
      if (!attempt.ok) return portError(attempt.error.kind, REFUSAL);
      const observedAt = this.options.clock.now();
      parseHostedAttempt(attempt.value, execution, observedAt);
      const jobs = await this.readHostedAttemptJobs(execution, deadline);
      if (!jobs.ok) return portError(jobs.error.kind, REFUSAL);
      const job = jobs.value.repair;
      if (job === null || job.status !== "completed") return portOk(null);
      const step = job.runtimeStep;
      if (
        job.startedAt === null || job.completedAt === null || step === null ||
        step.status !== "completed" || step.startedAt === null ||
        step.completedAt === null
      ) return portError("unavailable", REFUSAL);
      const log = await this.readHostedRuntimeLog(job.id, deadline);
      if (!log.ok) return portError(log.error.kind, REFUSAL);
      const tolerance = HOSTED_ACTIONS_CLOCK_TOLERANCE_MS;
      let found: ReviewOwnerSettlementProofV1 | null = null;
      for (const line of log.value.split(/\r?\n/)) {
        const match = HOSTED_EXECUTION_TERMINAL_LINE.exec(line);
        if (match === null) {
          if (CARRIER_LOOKING.test(line)) {
            return portError("unavailable", REFUSAL);
          }
          continue;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(match[2]);
        } catch {
          if (CARRIER_LOOKING.test(match[2])) {
            return portError("unavailable", REFUSAL);
          }
          continue;
        }
        if (
          typeof raw !== "object" || raw === null ||
          (raw as Record<string, unknown>).kind !==
            "hosted_review_owner_settled"
        ) continue;
        const record = parseHostedReviewOwnerSettlement(raw);
        if (
          canonicalStringify(record.execution) !== canonicalStringify(execution)
        ) return portError("unavailable", REFUSAL);
        if (
          !sameReviewOwnerRegistration(expected, {
            repository: record.carrier.repository,
            reviewId: record.carrier.reviewId,
            journal: record.carrier.journal,
            bodyDigest: record.carrier.bodyDigest,
          })
        ) continue;
        const terminalAt = Date.parse(match[1]);
        if (
          found !== null || !Number.isSafeInteger(terminalAt) ||
          expected.journal.requestedAt + tolerance < step.startedAt ||
          record.carrier.settledAt + tolerance < step.startedAt ||
          record.carrier.settledAt > step.completedAt + tolerance ||
          terminalAt + tolerance < record.carrier.settledAt ||
          terminalAt > job.completedAt + tolerance ||
          terminalAt > observedAt + tolerance ||
          step.startedAt + tolerance < job.startedAt ||
          step.completedAt > job.completedAt + tolerance
        ) return portError("unavailable", REFUSAL);
        found = {
          record,
          jobId: job.id,
          observedAt,
          finishedAt: job.completedAt,
          logDigest: await sha256Hex(log.value),
        };
      }
      return portOk(found);
    } catch {
      return portError("unavailable", REFUSAL);
    } finally {
      deadline.dispose();
    }
  }
}
