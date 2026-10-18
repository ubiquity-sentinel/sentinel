/**
 * JAM B12 fixtures: the live ai.ubq.fi delivery records whose pull request
 * merged and whose source issue closed while their production release request
 * stays open, because the Sentinel release path is disabled and the release
 * ref holds no VPS release record. The record, request and receipt shapes are
 * the exact live ones (`tests/fixtures/repair/release-deferred-live.json`);
 * the release snapshot is a found one without any `vpsReleases`, as live.
 *
 * R80 (the runtime rollback target) and the live launcher L-3f041b46d (the
 * launcher rollback target, with its `ops/` tree) are loaded read-only from
 * the local object store for the rollback cases; a shallow checkout without
 * them reports `revisionAvailable(...) === false` and those cases are
 * ignored.
 */
import { OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION } from "../../src/host/owner-install-runtime-pins.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";

const raw = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/repair/release-deferred-live.json", import.meta.url),
  ),
);

/** The live records (670 bound, 618 carried, 595 newest), request, receipt. */
export const LIVE_RECORDS: readonly WorkRecordV1[] = raw.records.map(
  (record: unknown) => parseWorkRecordV1(record),
);
export const LIVE_REQUESTS: readonly ReleaseRequestV1[] = raw.releaseRequests
  .map((request: unknown) => parseReleaseRequestV1(request));
export const LIVE_REVIEWS: readonly ReviewReceiptV1[] = raw.reviews.map(
  (receipt: unknown) => parseReviewReceiptV1(receipt),
);
/** Repair sequence and instant the fixture was taken at. */
export const LIVE_SEQUENCE: number = raw.sequence;
export const LIVE_UPDATED_AT: number = raw.updatedAt;
/** The live Gateway installation scope the records carry. */
export const LIVE_REPO = LIVE_RECORDS[0].repository;
/** The live source-issue statements (their digests are the receipts'). */
export const LIVE_TASKS: readonly {
  issueNumber: number;
  title: string;
  body: string;
}[] = raw.tasks.map((
  task: { issueNumber: number; title: string; body: string },
) => ({
  issueNumber: task.issueNumber,
  title: task.title,
  body: task.body,
}));
/** The live merged pull request facts (merge commit, parents, author). */
export const LIVE_PULLS: readonly {
  number: number;
  state: string;
  merged: boolean;
  mergeCommitSha: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  author: string;
  parents: string[];
  revisionOnBaseBranch: boolean;
  baseAncestorOfRevision: boolean;
}[] = raw.pulls;

/** A found release snapshot with no VPS release record, as the live ref. */
export function releaseWithoutVps(updatedAt: number): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  });
}

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");
const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** The installed generation-80 runtime, the next generation's rollback. */
export const R80: string = OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION;
/** The live launcher this lane is built on, the launcher rollback target. */
export const LIVE_LAUNCHER = "3f041b46d95269b29054ca5c27bce6aa179f9683";

/** True when `revision` is in the local object store. */
export async function revisionAvailable(revision: string): Promise<boolean> {
  try {
    const probe = await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${revision}^{commit}`],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "null",
      stderr: "null",
    }).output();
    return probe.success;
  } catch {
    return false;
  }
}

/**
 * Import `paths` (repository-relative) from `revision`'s `src/` and `tests/`
 * trees (and `ops/` with `withOps`), extracted under the repository root; the
 * tree stays until `dispose`, so the modules' own lazy imports still resolve.
 */
export async function loadRevisionModules(
  revision: string,
  paths: readonly string[],
  withOps = false,
): Promise<{
  modules: Record<string, unknown>[];
  dispose(): Promise<void>;
}> {
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-release-deferred-rollback-",
  });
  const dispose = () => Deno.remove(dir, { recursive: true }).catch(() => {});
  try {
    const archive = await new Deno.Command("git", {
      args: [
        "-C",
        ROOT,
        "archive",
        "--format=tar",
        revision,
        "src",
        "tests",
        ...(withOps ? ["ops"] : []),
      ],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error("rollback source unavailable");
    await Deno.writeFile(`${dir}/tree.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/tree.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    if (!extracted.success) throw new Error("rollback source unreadable");
    const modules: Record<string, unknown>[] = [];
    for (const path of paths) {
      modules.push(await import(new URL(`file://${dir}/${path}`).href));
    }
    return { modules, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** The live records as the new runtime leaves them: deferred at `at`. */
export function deferredLiveRecords(at: number): WorkRecordV1[] {
  return LIVE_RECORDS.map((record) =>
    parseWorkRecordV1({
      ...record,
      wait: { reason: "unavailable", since: at, until: null },
      updatedAt: at,
    })
  );
}
