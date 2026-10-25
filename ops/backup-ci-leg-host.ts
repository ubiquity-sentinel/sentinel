/**
 * The production dependencies of a hosted backup CI leg job
 * (docs/backup-ci-spec.md §10): environment reads that never throw under a
 * narrowed `--allow-env`, the launcher root from this module's own location
 * (no read permission needed), `tar` and `act --version` with a cleared
 * environment, and the act service through `sudo -n systemd-run`, whose
 * stdout and stderr lines stream to the sanitizer as they arrive.
 */
import type { BackupCiLegDepsV1 } from "./backup-ci-leg.ts";
import type { BackupCiGitV1 } from "./backup-ci-materialize.ts";

const SYSTEM_PATH = "/usr/bin:/bin";

/** `Deno.env.get` that reads a denied variable as unset. */
export function safeEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

export function productionLegDeps(git: BackupCiGitV1): BackupCiLegDepsV1 {
  const runTemp = safeEnv("RUNNER_TEMP") ?? "";
  if (!runTemp.startsWith("/")) throw new Error("RUNNER_TEMP is required");
  const encoder = new TextEncoder();
  return {
    env: safeEnv,
    runTemp,
    launcherRoot: decodeURIComponent(new URL("..", import.meta.url).pathname)
      .replace(/\/$/, ""),
    home: safeEnv("HOME") ?? "/home/runner",
    now: () => Date.now(),
    print: (line) => Deno.stdout.writeSync(encoder.encode(`${line}\n`)),
    git,
    async tar(args) {
      const out = await new Deno.Command("tar", {
        args,
        clearEnv: true,
        env: { PATH: SYSTEM_PATH, LC_ALL: "C" },
        stdout: "piped",
        stderr: "null",
      }).output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
    },
    async service(argv, onLine) {
      const started = Date.now();
      const child = new Deno.Command("sudo", {
        args: ["-n", ...argv],
        clearEnv: true,
        env: { PATH: SYSTEM_PATH },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        let partial = "";
        for await (const text of stream.pipeThrough(new TextDecoderStream())) {
          partial += text;
          const lines = partial.split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) onLine(line);
        }
        if (partial.length > 0) onLine(partial);
      };
      await Promise.all([pump(child.stdout), pump(child.stderr)]);
      const status = await child.status;
      return { code: status.code, elapsedMs: Date.now() - started };
    },
    async actVersion(act) {
      const out = await new Deno.Command(act, {
        args: ["--version"],
        clearEnv: true,
        env: { PATH: SYSTEM_PATH },
        stdout: "piped",
        stderr: "null",
      }).output().catch(() => null);
      return out?.success ? new TextDecoder().decode(out.stdout) : null;
    },
    etcEnvironment: () => Deno.readTextFile("/etc/environment").catch(() => ""),
    async nodeDir() {
      for (const dir of (safeEnv("PATH") ?? "").split(":")) {
        if (!dir.startsWith("/")) continue;
        try {
          const info = await Deno.stat(`${dir}/node`);
          if (info.isFile) return dir;
        } catch { /* next PATH entry */ }
      }
      return null;
    },
  };
}
