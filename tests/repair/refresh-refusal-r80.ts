/**
 * The installed generation-80 runtime (R80, e48e7e110), the rollback target of
 * the next runtime generation, for the refresh-refusal rollback proofs: R80's
 * own strict repair-state parser and its own work selection, imported from
 * the exact `src` tree of the pinned commit, extracted read-only from the local
 * object store (`git archive`) into a disposable directory under the
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

/** R80's own strict parser and work selection. */
export interface R80RuntimeV1 {
  /** R80's `parseRepairStateSnapshotV1` over a JSON round trip. */
  parse(snapshot: unknown): unknown;
  /** R80's `rankEligibleWork` skip reason for one record id (no configs). */
  skipReason(snapshot: unknown, id: string, now: number): string | undefined;
}

/** Run `use` with R80's own modules; the extracted tree is always removed. */
export async function withR80<T>(
  use: (runtime: R80RuntimeV1) => T | Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-r80-refresh-refusal-",
  });
  try {
    const archive = await new Deno.Command("git", {
      args: ["-C", ROOT, "archive", "--format=tar", R80_RUNTIME, "src"],
      clearEnv: true,
      env: GIT_ENV,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!archive.success) throw new Error("R80 source unavailable");
    await Deno.writeFile(`${dir}/src.tar`, archive.stdout);
    const extracted = await new Deno.Command("tar", {
      args: ["-xf", `${dir}/src.tar`, "-C", dir],
      clearEnv: true,
      env: { PATH: GIT_ENV.PATH },
      stdout: "null",
      stderr: "null",
    }).output();
    if (!extracted.success) throw new Error("R80 source unreadable");
    const snapshots = await import(
      new URL(`file://${dir}/src/contracts/state-snapshots.ts`).href
    );
    const selection = await import(
      new URL(`file://${dir}/src/repair/selection.ts`).href
    );
    const parse = (snapshot: unknown) =>
      snapshots.parseRepairStateSnapshotV1(
        JSON.parse(JSON.stringify(snapshot)),
      );
    return await use({
      parse,
      skipReason: (snapshot, id, now) =>
        selection.rankEligibleWork(parse(snapshot), [], now).skipped[id],
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
