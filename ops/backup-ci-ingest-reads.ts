/**
 * The Sentinel-repository reads of the trusted backup CI pass
 * (docs/backup-ci-spec.md §9.1, §9.2, §9.3 free slots), over the trusted
 * job's native token: the run's own identity, leg runs, their attempt-1 jobs,
 * job logs and result artifacts (by id only), the leg admission counts and
 * whether supervisor matrix cells are active. Every read is fail-closed.
 *
 * Result artifacts are unzipped with the lazily loaded zip.js (the same
 * pinned version and non-literal specifier as the matrix artifact reader):
 * exactly one regular entry `result.json`, declared and streamed size at
 * most 64 KiB.
 */
import {
  BACKUP_CI_LEG_WORKFLOW_PATH,
  BACKUP_CI_MAX_RESULT_BYTES,
} from "../src/contracts/backup-ci.ts";
import {
  type BackupCiApiV1,
  backupCiCompleteListing,
} from "./backup-ci-plan-reads.ts";

export const BACKUP_CI_SENTINEL_REPOSITORY = "ubiquity-sentinel/sentinel";
export const BACKUP_CI_LOG_MAX_BYTES = 8 * 2 ** 20;
const LEG_WORKFLOW = BACKUP_CI_LEG_WORKFLOW_PATH.slice(
  BACKUP_CI_LEG_WORKFLOW_PATH.lastIndexOf("/") + 1,
);

type Obj = Record<string, unknown>;
const row = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : null;

export interface BackupCiLegReadsV1 {
  /** Leg runs created at or after `since` (epoch ms), complete. */
  legRuns(since: number): Promise<Obj[] | null>;
  attempt(runId: number): Promise<Obj | null>;
  /** Attempt 1's jobs, complete. */
  jobs(runId: number): Promise<Obj[] | null>;
  log(jobId: number): Promise<string | "unserved" | null>;
  artifact(id: number): Promise<Obj | null>;
  artifactZip(id: number): Promise<Uint8Array | null>;
  cancel(runId: number): Promise<boolean>;
  /** Leg runs queued plus in progress. */
  inflight(): Promise<number | null>;
  /** Whether an in-progress supervisor run has a matrix cell job going. */
  cellsActive(): Promise<boolean | null>;
}

export function createBackupCiLegReads(
  api: BackupCiApiV1,
  repository: string = BACKUP_CI_SENTINEL_REPOSITORY,
): BackupCiLegReadsV1 {
  const repo = `/repos/${repository}`;
  const runsOf = (workflow: string, query: string) => (page: number) =>
    `${repo}/actions/workflows/${workflow}/runs?${query}&per_page=100&page=${page}`;
  const count = async (status: string) => {
    const body = row(
      await api.get(
        `${repo}/actions/workflows/${LEG_WORKFLOW}/runs?status=${status}&per_page=1`,
      ),
    );
    const total = body?.total_count;
    return typeof total === "number" && Number.isSafeInteger(total) &&
        total >= 0
      ? total
      : null;
  };
  return {
    legRuns: (since) =>
      backupCiCompleteListing(
        api,
        runsOf(
          LEG_WORKFLOW,
          `event=workflow_dispatch&branch=sentinel-backup-legs&created=${
            encodeURIComponent(`>=${new Date(since).toISOString()}`)
          }`,
        ),
        "workflow_runs",
      ),
    attempt: async (runId) =>
      row(await api.get(`${repo}/actions/runs/${runId}/attempts/1`)),
    jobs: (runId) =>
      backupCiCompleteListing(
        api,
        (page) =>
          `${repo}/actions/runs/${runId}/attempts/1/jobs?per_page=100&page=${page}`,
        "jobs",
        2,
      ),
    async log(jobId) {
      const bytes = await api.redirected(
        `${repo}/actions/jobs/${jobId}/logs`,
        BACKUP_CI_LOG_MAX_BYTES,
      );
      if (bytes === null || bytes === "unserved") return bytes;
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    },
    artifact: async (id) =>
      row(await api.get(`${repo}/actions/artifacts/${id}`)),
    async artifactZip(id) {
      const bytes = await api.redirected(
        `${repo}/actions/artifacts/${id}/zip`,
        BACKUP_CI_MAX_RESULT_BYTES,
      );
      return bytes instanceof Uint8Array ? bytes : null;
    },
    async cancel(runId) {
      const out = await api.send(
        "POST",
        `${repo}/actions/runs/${runId}/cancel`,
      );
      return out !== null && out.status >= 200 && out.status < 300;
    },
    async inflight() {
      const [queued, running] = await Promise.all([
        count("queued"),
        count("in_progress"),
      ]);
      return queued === null || running === null ? null : queued + running;
    },
    async cellsActive() {
      const runs = await backupCiCompleteListing(
        api,
        runsOf("supervisor.yml", "status=in_progress"),
        "workflow_runs",
        2,
      );
      if (runs === null) return null;
      for (const run of runs) {
        const jobs = await backupCiCompleteListing(
          api,
          (page) =>
            `${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
          "jobs",
          4,
        );
        if (jobs === null) return null;
        if (
          jobs.some((job) =>
            typeof job.name === "string" &&
            job.name.startsWith("matrix_cell") &&
            (job.status === "queued" || job.status === "in_progress")
          )
        ) return true;
      }
      return false;
    },
  };
}

/**
 * The bytes of `result.json`, the only entry of a result artifact zip, or
 * null for any other shape, a declared or streamed size past 64 KiB, or a
 * zip that does not read strictly.
 */
export async function unzipBackupCiResult(
  zip: Uint8Array,
): Promise<Uint8Array | null> {
  // The npm specifier stays non-literal so zip.js loads only when a result
  // artifact is actually read (see matrix-artifact-archive.ts).
  const zipSpec = ["npm:@zip.js/zip.js", "2.8.34"].join("@");
  try {
    const { Uint8ArrayReader, ZipReader } = await import(zipSpec);
    const reader = new ZipReader(new Uint8ArrayReader(zip), {
      useWebWorkers: false,
      strictness: "strict",
      checkSignature: true,
      checkOverlappingEntry: true,
    });
    let bytes: Uint8Array | null = null;
    let entries = 0;
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        entries++;
        const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (
          entries > 1 || entry.filename !== "result.json" || entry.directory ||
          entry.encrypted || (type !== 0 && type !== 0x8000) ||
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0 ||
          entry.uncompressedSize > BACKUP_CI_MAX_RESULT_BYTES
        ) return null;
        const chunks: Uint8Array[] = [];
        let length = 0;
        let over = false;
        await entry.getData(
          new WritableStream<Uint8Array>({
            write(chunk) {
              length += chunk.length;
              if (length > BACKUP_CI_MAX_RESULT_BYTES) {
                over = true;
                throw new Error("result too large");
              }
              chunks.push(chunk);
            },
          }),
        );
        if (over || length !== entry.uncompressedSize) return null;
        bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
      }
    } finally {
      await reader.close();
    }
    return entries === 1 ? bytes : null;
  } catch {
    return null;
  }
}
