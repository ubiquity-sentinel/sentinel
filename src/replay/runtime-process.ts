import type { ChildProcess } from "node:child_process";
import { kill } from "node:process";

export const TERM_GRACE_MS = 250;
export const GROUP_POLL_MS = 25;
export const STREAM_MARGIN_MS = 500;

/** POSIX platforms where a detached child leads its own signalable group. */
export const SUPPORTED_POSIX_OS = new Set([
  "aix",
  "darwin",
  "freebsd",
  "illumos",
  "linux",
  "netbsd",
  "openbsd",
  "solaris",
]);

/** Signal -> conventional exit code (128 + signal), for signal deaths. */
export const SIGNAL_EXIT_CODE: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
};

/**
 * Bounded owned-group termination: SIGTERM the recorded group, wait (up to
 * the grace) for the group to become provably empty, then SIGKILL and wait
 * again. Only `-groupId` is ever signaled.
 */
export async function terminateOwnedGroup(
  groupId: number,
): Promise<"empty" | "uncertain"> {
  try {
    signalGroup(groupId, "SIGTERM");
  } catch {
    return "uncertain";
  }
  const afterTerm = await waitGroupEmpty(groupId, TERM_GRACE_MS);
  if (afterTerm === "empty") return "empty";
  try {
    signalGroup(groupId, "SIGKILL");
  } catch {
    return "uncertain";
  }
  const afterKill = await waitGroupEmpty(groupId, TERM_GRACE_MS);
  return afterKill === "empty" ? "empty" : "uncertain";
}

export function signalGroup(
  groupId: number,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    kill(-groupId, signal);
  } catch (error) {
    // NotFound already means an empty group; anything else must not be
    // swallowed — it makes settlement unprovable.
    if (!isGroupMissing(error)) throw error;
  }
}

export async function waitGroupEmpty(
  groupId: number,
  maxMs: number,
): Promise<"empty" | "pending"> {
  if (maxMs <= 0) return groupAlive(groupId) ? "pending" : "empty";
  const deadline = Date.now() + maxMs;
  while (true) {
    if (!groupAlive(groupId)) return "empty";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "pending";
    await delay(Math.min(GROUP_POLL_MS, remaining));
  }
}

/** True while any member of the owned group exists (0 = probe signal). */
export function groupAlive(groupId: number): boolean {
  try {
    kill(-groupId, 0);
    return true;
  } catch (error) {
    if (isGroupMissing(error)) return false;
    // Cannot verify: fail closed by treating the group as alive.
    return true;
  }
}

export function isGroupMissing(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ESRCH" || error instanceof Deno.errors.NotFound;
}

export function exitCodeFor(
  code: number | null,
  signal: string | null,
): number | null {
  if (code !== null) return code;
  if (signal === null) return null;
  const base = SIGNAL_EXIT_CODE[signal];
  return base === undefined ? null : 128 + base;
}

export function destroyStreams(child: ChildProcess): void {
  try {
    child.stdout?.destroy();
  } catch {
    // Best effort; nothing to reap.
  }
  try {
    child.stderr?.destroy();
  } catch {
    // Best effort; nothing to reap.
  }
}

/**
 * Resolve `promise` if it settles within `timeoutMs`; else resolve null.
 * The timer is always cleared or consumed exactly once — no timer outlives
 * the returned promise.
 */
export function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      },
    );
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded error text for diagnostics; never raw child output. */
export function describeThrow(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const single = text.replace(/[\r\n\t]+/g, " ").trim();
  return single.length === 0 ? "unknown error" : single.slice(0, 160);
}
