/** Authenticated native Actions CI, never a model-supplied check receipt. */
import type { GitSha } from "../contracts/brands.ts";
import {
  NATIVE_CI_MARKER,
  type NativeCiEvidenceV1,
  parseNativeCiProof,
} from "../contracts/native-ci.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import { GitHubClientReviewOwner } from "./client-review-owner.ts";
import { createDeadline } from "./http.ts";
import { nextLinkUrl } from "./client-response.ts";

export interface NativeCiReadV1 {
  head: GitSha;
  base: GitSha;
  pr: number;
  headRef: string;
}
type Row = Record<string, unknown>;
class NativeCiRequestError extends Error {
  constructor(readonly result: PortResultV1<never>) {
    super("native CI request unavailable");
  }
}
function row(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error();
  }
  return value as Row;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error();
  }
  return value;
}
function date(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error();
  }
  return Date.parse(value);
}

export abstract class GitHubClientNativeCi extends GitHubClientReviewOwner {
  async readNativeCiEvidence(
    input: NativeCiReadV1,
  ): Promise<PortResultV1<NativeCiEvidenceV1>> {
    if (
      this.repository.owner !== "Ubiquity-Sentinel" ||
      this.repository.name !== "sentinel" ||
      this.repository.installationId !== 0
    ) return portError("invalid", "native CI self scope mismatch");
    const deadline = createDeadline(this.requestDeadlineMs);
    const get = async (path: string): Promise<Row> => {
      const result = await this.sendCore(
        "GET",
        `${this.apiBaseUrl}/repos/Ubiquity-Sentinel/sentinel${path}`,
        null,
        undefined,
        deadline,
      );
      if (result.status === "error") {
        throw new NativeCiRequestError(
          portError(
            result.error.kind,
            result.error.detail,
            result.error.rateLimit,
          ),
        );
      }
      if (result.status === "response" && result.response.status !== 200) {
        throw new NativeCiRequestError(
          portError(...this.mapError(result.response)),
        );
      }
      if (
        result.status !== "response" || result.response.status !== 200 ||
        nextLinkUrl(result.response.headers) !== null
      ) throw new Error();
      return row(JSON.parse(result.response.bodyText));
    };
    try {
      const page = await get(
        `/commits/${input.head}/check-runs?check_name=test-local&filter=latest&per_page=100`,
      );
      const checks = page.check_runs;
      if (
        !Array.isArray(checks) || checks.length !== page.total_count ||
        checks.length === 0 || checks.length > 100
      ) throw new Error();
      const native = checks.map(row).filter((c) => c.name === "test-local");
      if (native.length === 0) throw new Error();
      native.sort((a, b) => date(b.started_at) - date(a.started_at));
      const check = native[0];
      if (
        native.length > 1 &&
        date(native[1].started_at) === date(check.started_at)
      ) throw new Error();
      if (
        check.head_sha !== input.head || check.status !== "completed" ||
        check.conclusion !== "success" ||
        row(check.app).slug !== "github-actions" || row(check.app).id !== 15368
      ) throw new Error();
      const checkId = count(check.id);
      const details = new URL(String(check.details_url));
      const matched =
        /^\/Ubiquity-Sentinel\/sentinel\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/
          .exec(details.pathname);
      if (
        details.protocol !== "https:" || details.hostname !== "github.com" ||
        details.username || details.password || details.search ||
        details.hash || matched === null
      ) throw new Error();
      const runId = count(Number(matched[1]));
      const jobId = count(Number(matched[2]));
      const run = await get(`/actions/runs/${runId}`);
      const repository = row(run.repository);
      if (
        run.id !== runId || run.head_sha !== input.head ||
        run.event !== "pull_request" || run.status !== "completed" ||
        run.conclusion !== "success" || typeof run.path !== "string" ||
        run.path.split("@")[0] !== ".github/workflows/ci.yml" ||
        repository.full_name !== "Ubiquity-Sentinel/sentinel"
      ) throw new Error();
      const repositoryId = count(repository.id);
      const attempt = count(run.run_attempt);
      const pulls = run.pull_requests;
      if (!Array.isArray(pulls) || pulls.length !== 1) throw new Error();
      const pull = row(pulls[0]);
      const head = row(pull.head), base = row(pull.base);
      if (
        pull.number !== input.pr || head.sha !== input.head ||
        head.ref !== input.headRef || base.ref !== "development" ||
        row(head.repo).id !== repositoryId || row(base.repo).id !== repositoryId
      ) throw new Error();
      const workflow = await get(
        `/actions/workflows/${count(run.workflow_id)}`,
      );
      if (
        workflow.id !== run.workflow_id ||
        workflow.path !== ".github/workflows/ci.yml" ||
        workflow.state !== "active"
      ) throw new Error();
      const jobs = await get(
        `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
      );
      if (
        !Array.isArray(jobs.jobs) || jobs.jobs.length !== jobs.total_count ||
        jobs.jobs.length > 100
      ) throw new Error();
      const found = jobs.jobs.map(row).filter((j) => j.id === jobId);
      if (found.length !== 1) throw new Error();
      const job = found[0];
      if (
        job.run_id !== runId || job.run_attempt !== attempt ||
        job.name !== "test-local" || job.status !== "completed" ||
        job.conclusion !== "success" ||
        job.check_run_url !==
          `${this.apiBaseUrl}/repos/Ubiquity-Sentinel/sentinel/check-runs/${checkId}`
      ) throw new Error();
      if (!Array.isArray(job.steps)) throw new Error();
      const carriers = job.steps.map(row).filter((s) =>
        s.name === "Credential-free local harness"
      );
      if (
        carriers.length !== 1 || carriers[0].status !== "completed" ||
        carriers[0].conclusion !== "success"
      ) throw new Error();
      const from = date(carriers[0].started_at),
        until = date(carriers[0].completed_at);
      if (from > until || until > this.options.clock.now()) throw new Error();
      const log = await this.readHostedRuntimeLog(jobId, deadline);
      if (!log.ok) return log;
      const markers = log.value.split(/\r?\n/).filter((line) =>
        line.includes(NATIVE_CI_MARKER)
      );
      if (markers.length !== 1) throw new Error();
      const match = /^(\d{4}-\d{2}-\d{2}T\S+) sentinel_native_ci_v1:(.+)$/.exec(
        markers[0],
      );
      if (
        match === null || date(match[1]) < from - 1000 ||
        date(match[1]) > until + 1000 || match[2].length > 8192
      ) throw new Error();
      const proof = parseNativeCiProof(JSON.parse(match[2]));
      if (
        proof.repositoryId !== repositoryId || proof.runId !== runId ||
        proof.attempt !== attempt || proof.pr !== input.pr ||
        proof.head !== input.head || proof.base !== input.base ||
        proof.headRef !== input.headRef
      ) throw new Error();
      // Reread the exact native attempt: a rerun transition cannot reuse its old log.
      const current = await get(`/actions/runs/${runId}`);
      if (
        current.id !== runId || current.run_attempt !== attempt ||
        current.head_sha !== input.head || current.status !== "completed" ||
        current.conclusion !== "success"
      ) throw new Error();
      return portOk({ proof, jobId, checkId });
    } catch (error) {
      return error instanceof NativeCiRequestError ? error.result : portError(
        "unavailable",
        "native CI evidence unavailable or mismatched",
      );
    }
  }
}
