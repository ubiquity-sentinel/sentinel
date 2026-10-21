/** Complete bounded native exclusion of pre-existing hosted writers. Read only. */
import { isGitSha } from "../contracts/brands.ts";
import {
  HOSTED_CONTROLLER_API_PATH,
  HOSTED_CONTROLLER_DEPLOYMENT,
} from "../contracts/hosted-controller-deployment.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { Clock } from "../contracts/ports.ts";
import type { HostedSupervisorRunIdentityV1 } from "./actions-supervisor-types.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  type ExistingPrRuntimeCapability,
} from "./existing-pr-runtime-capability.ts";
import { isRecord, ownerDevelopmentInstallApi } from "./owner-install-api.ts";

const ROOT = HOSTED_CONTROLLER_API_PATH;
const WORKFLOWS = ["supervisor.yml", "repair.yml", "release.yml"] as const;
const NONTERMINAL = [
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
] as const;
const MAX_PAGES = 20;
const SUCCESSORS = new Set([
  "prepare",
  "matrix_plan",
  "matrix_cell",
  "repair",
  "finalize",
]);

export type HostedWriterQuiescence =
  | { status: "ready"; run: HostedSupervisorRunIdentityV1 }
  | { status: "blocked" | "unavailable"; reason: string };

export interface HostedWriterQuiescenceInput {
  token: string;
  run: HostedSupervisorRunIdentityV1;
  phase: "prepare" | "maintenance";
  clock: Clock;
  deadline: number;
  /** Trusted fixture transport; production always uses authenticated native GETs. */
  read?: (path: string) => Promise<unknown | null>;
}

/**
 * The fixed native run lock serializes writers, but a queued older attempt must
 * also be absent before activation. This proves today's drain, not a permanent
 * ban on a future owner-triggered rerun of historical workflow source.
 */
export async function readHostedWriterQuiescence(
  input: HostedWriterQuiescenceInput,
  /** Fixture seam; production policy comes from the verified clean launcher source. */
  custody: ExistingPrRuntimeCapability = EXISTING_PR_RUNTIME_CAPABILITY,
): Promise<HostedWriterQuiescence> {
  const unavailable = (): HostedWriterQuiescence => ({
    status: "unavailable",
    reason: "hosted writer inventory unavailable",
  });
  const blocked = (): HostedWriterQuiescence => ({
    status: "blocked",
    reason: "another hosted writer is not terminal",
  });
  const live = () =>
    Number.isSafeInteger(input.deadline) &&
    Number.isSafeInteger(input.clock.now()) &&
    input.clock.now() < input.deadline;
  if (
    !live() || !isGitSha(input.run.launcherSha) ||
    !Number.isSafeInteger(input.run.runId) || input.run.runId < 1 ||
    !Number.isSafeInteger(input.run.runAttempt) || input.run.runAttempt < 1 ||
    !["prepare", "maintenance"].includes(input.phase)
  ) return unavailable();
  const read = async (path: string): Promise<unknown | null> => {
    if (!live()) return null;
    const value = input.read
      ? await input.read(path)
      : await ownerDevelopmentInstallApi(input.token, "GET", path).then((r) =>
        r.ok && r.value.status === 200 ? r.value.value : null
      );
    return live() ? value : null;
  };
  const list = async (path: string, key: "jobs" | "workflow_runs") => {
    const rows: Record<string, unknown>[] = [];
    let total: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const value = await read(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (
        !isRecord(value) || !Number.isSafeInteger(value.total_count) ||
        (value.total_count as number) < 0 || !Array.isArray(value[key]) ||
        (total !== undefined && total !== value.total_count)
      ) return null;
      total = value.total_count as number;
      const batch = value[key] as unknown[];
      if (
        batch.length > 100 ||
        batch.some((row) =>
          !isRecord(row) || !Number.isSafeInteger(row.id) ||
          (row.id as number) < 1
        )
      ) return null;
      rows.push(...batch as Record<string, unknown>[]);
      if (
        rows.length > total ||
        new Set(rows.map((r) => r.id)).size !== rows.length
      ) return null;
      if (rows.length === total) return rows;
      if (batch.length !== 100) return null;
    }
    return null;
  };
  try {
    let previous: string | undefined;
    // The second complete inventory detects source, attempt and listing drift.
    for (let pass = 0; pass < 2; pass++) {
      const ref = await read(`${ROOT}/git/ref/heads/sentinel-supervisor`);
      if (
        !isRecord(ref) || !isRecord(ref.object) ||
        ref.object.sha !== input.run.launcherSha
      ) return unavailable();
      const path =
        `${ROOT}/actions/runs/${input.run.runId}/attempts/${input.run.runAttempt}`;
      const run = await read(path);
      if (
        !isRecord(run) || !sameRun(run, input.run) ||
        run.status !== "in_progress"
      ) return unavailable();
      const jobs = await list(`${path}/jobs`, "jobs");
      if (
        !jobs || jobs.length === 0 ||
        jobs.filter((job) =>
            job.name === input.phase && job.status === "in_progress"
          ).length !== 1 ||
        jobs.some((job) =>
          job.head_sha !== input.run.launcherSha ||
          (job.status !== "completed" &&
            !(job.name === input.phase && job.status === "in_progress") &&
            !(job.status === "queued" && job.started_at === null &&
              (job.runner_id === 0 || job.runner_id === null) &&
              typeof job.name === "string" && SUCCESSORS.has(job.name)))
        )
      ) return unavailable();
      const inventory: Record<string, unknown>[][] = [];
      for (const workflow of WORKFLOWS) {
        for (const status of NONTERMINAL) {
          const rows = await list(
            `${ROOT}/actions/workflows/${workflow}/runs?status=${status}`,
            "workflow_runs",
          );
          if (!rows || rows.some((row) => row.status !== status)) {
            return unavailable();
          }
          for (const row of rows) {
            if (workflow === "supervisor.yml" && sameRun(row, input.run)) {
              continue;
            }
            // A normal fixed-ref dispatch can already be waiting behind this
            // run. Identical accepted source has the same guarded future entry
            // points; neither a moving branch nor a descendant is sufficient.
            if (
              custody?.custodyActivated !== true ||
              workflow !== "supervisor.yml" ||
              status === "in_progress" || row.id === input.run.runId ||
              !Number.isSafeInteger(row.run_attempt) ||
              (row.run_attempt as number) < 1 ||
              !sameRun(row, {
                ...input.run,
                runId: row.id as number,
                runAttempt: row.run_attempt as number,
              })
            ) return blocked();
            const pendingJobs = await list(
              `${ROOT}/actions/runs/${row.id}/attempts/${row.run_attempt}/jobs`,
              "jobs",
            );
            if (
              !pendingJobs ||
              pendingJobs.some((job) =>
                job.head_sha !== input.run.launcherSha ||
                job.status !== "queued" ||
                job.started_at !== null ||
                (job.runner_id !== 0 && job.runner_id !== null)
              )
            ) return blocked();
          }
          inventory.push(rows);
        }
      }
      const finalRef = await read(`${ROOT}/git/ref/heads/sentinel-supervisor`);
      if (
        !isRecord(finalRef) || !isRecord(finalRef.object) ||
        finalRef.object.sha !== input.run.launcherSha
      ) return unavailable();
      const current = canonicalStringify({ ref, run, jobs, inventory });
      if (previous !== undefined && previous !== current) return unavailable();
      previous = current;
    }
    return live() ? { status: "ready", run: { ...input.run } } : unavailable();
  } catch {
    return unavailable();
  }
}

function sameRun(
  row: Record<string, unknown>,
  run: HostedSupervisorRunIdentityV1,
): boolean {
  return row.id === run.runId && row.run_attempt === run.runAttempt &&
    row.head_sha === run.launcherSha &&
    row.head_branch === "sentinel-supervisor" &&
    row.workflow_id === HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowId &&
    row.path === HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowPath;
}
