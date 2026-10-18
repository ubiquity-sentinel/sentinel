/**
 * The installed generation-80 runtime's (R80, e48e7e110) own strict repair
 * state parser, for rollback proofs: generation 81's rollback target must
 * parse and accept every state shape new code writes. The exact `src/contracts`
 * tree and the native review parser dependency closure are extracted
 * read-only from the local object store into a disposable directory under the
 * repository root. A shallow checkout without the pinned commit reports
 * `r80Available() === false` and callers mark the case ignored instead of
 * passing it silently.
 */
import { OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION } from "../../src/host/owner-install-runtime-pins.ts";

export const R80_RUNTIME: string = OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION;

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");

const GIT_ENV = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** True when the pinned R80 commit is in the local object store. */
export async function r80Available(): Promise<boolean> {
  try {
    const probe = await new Deno.Command("git", {
      args: ["-C", ROOT, "cat-file", "-e", `${R80_RUNTIME}^{commit}`],
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

/** R80's own strict parsers for every shape this lane writes. */
export interface R80ParsersV1 {
  parseRepairStateSnapshotV1(input: unknown): unknown;
  parseMatrixCellResultV1(input: unknown): unknown;
  parseMatrixPlanV1(input: unknown): unknown;
  parseRepositoryConfigV1(input: unknown): unknown;
  parseReviewExecutionV1(input: unknown): unknown;
  parseReviewReadyExecutionV1(input: unknown): unknown;
  parseReviewResultV1(input: unknown): unknown;
}

/** Run `use` with R80's own parsers over a JSON round trip of each input. */
export async function withR80Parsers<T>(
  use: (parsers: R80ParsersV1) => T | Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-r80-contracts-",
  });
  try {
    const archive = await new Deno.Command("git", {
      args: [
        "-C",
        ROOT,
        "archive",
        "--format=tar",
        R80_RUNTIME,
        "src/contracts",
        "src/github/journal-metadata.ts",
        "src/github/journal-json.ts",
        "src/github/journal-text.ts",
        "src/github/review-result-parser.ts",
        "src/github/review-result-contracts.ts",
      ],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error("R80 contracts unavailable");
    await Deno.writeFile(`${dir}/tree.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/tree.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    if (!extracted.success) throw new Error("R80 contracts unreadable");
    const state = await import(
      new URL(`file://${dir}/src/contracts/state-snapshots.ts`).href
    );
    const matrix = await import(
      new URL(`file://${dir}/src/contracts/matrix.ts`).href
    );
    const config = await import(
      new URL(`file://${dir}/src/contracts/repository-config.ts`).href
    );
    const metadata = await import(
      new URL(`file://${dir}/src/github/journal-metadata.ts`).href
    );
    const result = await import(
      new URL(`file://${dir}/src/github/review-result-parser.ts`).href
    );
    const roundTrip = (input: unknown) => JSON.parse(JSON.stringify(input));
    return await use({
      parseRepairStateSnapshotV1: (input) =>
        state.parseRepairStateSnapshotV1(roundTrip(input)),
      parseMatrixCellResultV1: (input) =>
        matrix.parseMatrixCellResultV1(roundTrip(input)),
      parseMatrixPlanV1: (input) => matrix.parseMatrixPlanV1(roundTrip(input)),
      parseRepositoryConfigV1: (input) =>
        config.parseRepositoryConfigV1(roundTrip(input)),
      parseReviewExecutionV1: (input) =>
        metadata.parseExecution(roundTrip(input), "$.execution"),
      parseReviewReadyExecutionV1: (input) =>
        metadata.parseReadyExecution(roundTrip(input), "$.execution"),
      parseReviewResultV1: (input) =>
        result.parseReviewResultV1(roundTrip(input)),
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Parse `snapshot` with R80's own `parseRepairStateSnapshotV1`. */
export function parseWithR80(snapshot: unknown): Promise<unknown> {
  return withR80Parsers((parsers) =>
    parsers.parseRepairStateSnapshotV1(snapshot)
  );
}
