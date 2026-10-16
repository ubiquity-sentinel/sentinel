/**
 * The exact installed generation-76 contract parsers, materialized from Git
 * beside the repository: a rollback-safety check feeds every state shape a
 * newer consumer writes through the strict parsers generation 76 runs.
 * No test registrations.
 */
import assert from "node:assert/strict";

export const GENERATION_76 = "41bb853a1bedfc0422bf903dfabbe23bf714b44f";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/\/$/, "");

export interface Generation76ParsersV1 {
  parseRepairState(value: unknown): unknown;
  parseCellResult(value: unknown): unknown;
}

export function generation76Present(): boolean {
  try {
    return new Deno.Command("git", {
      args: ["cat-file", "-e", `${GENERATION_76}^{commit}`],
      cwd: ROOT,
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

async function git(args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(output.success, new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout);
}

/** Run `use` with the generation-76 parsers; the scratch copy is removed. */
export async function withGeneration76Parsers<T>(
  use: (parsers: Generation76ParsersV1) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "sentinel-gen76-contracts-",
  });
  try {
    const files = (await git([
      "ls-tree",
      "-r",
      "--name-only",
      GENERATION_76,
      "src/contracts",
    ])).split("\n").filter((line) => line.length > 0);
    assert.ok(files.includes("src/contracts/state-snapshots.ts"));
    for (const file of files) {
      const target = `${dir}/${file}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(
        target,
        await git(["show", `${GENERATION_76}:${file}`]),
      );
    }
    const url = (file: string) =>
      new URL(`file://${dir}/src/contracts/${file}`).href;
    const snapshots = await import(url("state-snapshots.ts"));
    const matrix = await import(url("matrix.ts"));
    return await use({
      parseRepairState: snapshots.parseRepairStateSnapshotV1,
      parseCellResult: matrix.parseMatrixCellResultV1,
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** The generation-76 parser returns the exact wire value unchanged. */
export function assertGeneration76Accepts(
  parse: (value: unknown) => unknown,
  value: unknown,
  label: string,
): void {
  const wire = JSON.parse(JSON.stringify(value));
  assert.deepEqual(JSON.parse(JSON.stringify(parse(wire))), wire, label);
}
