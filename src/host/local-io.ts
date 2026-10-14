export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`local repair host requires environment variable ${name}`);
  }
  return value;
}

/** Trusted git: /usr/bin/git first, otherwise the trusted PATH. */
export function trustedGitPath(trustedPath: string): string {
  if (pathExistsSync("/usr/bin/git")) return "/usr/bin/git";
  for (const dir of trustedPath.split(":")) {
    const candidate = joinPath(dir.length > 0 ? dir : "/", "git");
    if (pathExistsSync(candidate)) return candidate;
  }
  return "git";
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  await Deno.chmod(path, 0o700);
}

export async function writePrivateFile(
  path: string,
  text: string,
): Promise<void> {
  await Deno.writeTextFile(path, text, { mode: 0o600 });
  await Deno.chmod(path, 0o600);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function joinPath(base: string, ...parts: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const part of parts) {
    out += "/" + part.replace(/^\/+|\/+$/g, "");
  }
  return out.length === 0 ? "/" : out;
}

export function dirnamePath(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return path.slice(0, index);
}
