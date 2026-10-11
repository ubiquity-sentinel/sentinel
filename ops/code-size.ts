/** Deno-native physical line inventory for tracked and new nonignored code. */
import { join, resolve } from "node:path";

export type CodeSizeEntry = {
  path: string;
  kind: "source" | "test";
  lines: number;
  bytes: number;
  review: number;
  ceiling: number;
};

export type CodeSizeInventory = {
  files: CodeSizeEntry[];
  deleted: string[];
};

const extensions = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "sh",
  "bash",
  "zsh",
  "fish",
  "py",
  "rb",
  "pl",
  "php",
  "rs",
  "go",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "java",
  "kt",
  "kts",
  "lua",
  "sql",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  "svelte",
  "vue",
]);

export function physicalLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/).length;
  return lines - (/[\r\n\u2028\u2029]$/.test(text) ? 1 : 0);
}

export function isTestCode(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) ||
    /[._](test|spec)\.[^.]+$/.test(path);
}

export function measureCode(path: string, bytes: Uint8Array): CodeSizeEntry {
  const test = isTestCode(path);
  return {
    path,
    kind: test ? "test" : "source",
    lines: physicalLines(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ),
    bytes: bytes.length,
    review: test ? 800 : 500,
    ceiling: test ? 1500 : 1000,
  };
}

export function exceedsCeiling(entry: CodeSizeEntry): boolean {
  return entry.lines > entry.ceiling;
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["-c", "core.fsmonitor=false", ...args],
    cwd: root,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `Code-size inventory requires a readable Git worktree (${result.code})`,
    );
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
}

function hasCodeExtension(path: string): boolean {
  return extensions.has(path.split(".").at(-1)?.toLowerCase() ?? "");
}

function hasCodeShebang(bytes: Uint8Array): boolean {
  return bytes[0] === 35 && bytes[1] === 33;
}

export async function inventoryCode(
  root = Deno.cwd(),
): Promise<CodeSizeInventory> {
  root = await Deno.realPath(root);
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).replace(
    /\n$/,
    "",
  );
  if (await Deno.realPath(root) !== await Deno.realPath(top)) {
    throw new Error("Run the code-size inventory from the Git worktree root");
  }
  const [listed, removed] = await Promise.all([
    git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
    git(root, ["ls-files", "--deleted", "-z"]),
  ]);
  const deleted = removed.split("\0").filter(Boolean);
  const absent = new Set(deleted);
  const files: CodeSizeEntry[] = [];
  for (const path of [...new Set(listed.split("\0").filter(Boolean))].sort()) {
    if (absent.has(path)) continue;
    const fullPath = join(root, path);
    if (
      resolve(fullPath) === resolve(root) || !fullPath.startsWith(`${root}/`)
    ) {
      throw new Error(
        `Invalid code-size inventory path: ${JSON.stringify(path)}`,
      );
    }
    const stat = await Deno.lstat(fullPath);
    // Never follow a link out of scope or silently hide code behind one.
    if (!stat.isFile) {
      throw new Error(
        `Code-size inventory requires a regular file: ${JSON.stringify(path)}`,
      );
    }
    const bytes = await Deno.readFile(fullPath);
    if (hasCodeExtension(path) || hasCodeShebang(bytes)) {
      files.push(measureCode(path, bytes));
    }
  }
  return { files, deleted };
}

export function formatInventory(inventory: CodeSizeInventory): string {
  const rows = inventory.files.map((entry) => {
    const status = exceedsCeiling(entry)
      ? "OVER CEILING"
      : entry.lines > entry.review
      ? "review"
      : "within target";
    return `${entry.lines}\t${entry.bytes}\t${entry.kind}\t${status}\t${
      JSON.stringify(entry.path)
    }`;
  });
  const violations = inventory.files.filter(exceedsCeiling).length;
  return [
    "lines\tbytes\tkind\tstatus\tpath",
    ...rows,
    `Code size: ${inventory.files.length} files; ${violations} over ceiling; ${inventory.deleted.length} deleted tracked paths.`,
  ].join("\n");
}

if (import.meta.main) {
  const mode = Deno.args[0] ?? "report";
  if (Deno.args.length > 1 || !["report", "check"].includes(mode)) {
    console.error("Usage: deno task size:report | deno task size:check");
    Deno.exit(2);
  }
  try {
    const inventory = await inventoryCode();
    console.log(formatInventory(inventory));
    if (mode === "check" && inventory.files.some(exceedsCeiling)) Deno.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }
}
