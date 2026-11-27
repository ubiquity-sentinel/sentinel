import type { AgentJobRunner, AgentJobsPlanV1 } from "./agent-jobs-plan.ts";

const PRIVATE_INCLUDED_MINUTES = 2_000;
const RUNNER_MULTIPLIER: Readonly<Record<AgentJobRunner, number>> = {
  "linux-x64": 1,
  "linux-arm64": 1,
  "linux-arm64-26": 1,
  "macos-arm64": 10,
};

/** Jobs on one cell run concurrently and share their absolute admission clock with review. */
export async function requirePrivateAgentJobsMinutes(
  plan: AgentJobsPlanV1,
  overage: string,
  readUsedMinutes: () => Promise<number>,
): Promise<void> {
  if (overage === "on") return;
  if (overage !== "" && overage !== "off") {
    throw new Error("private paid Actions overage setting is unavailable");
  }
  const used = await readUsedMinutes().catch(() => NaN);
  if (!Number.isSafeInteger(used) || used < 0) {
    throw new Error("private monthly Actions minutes are unavailable");
  }
  const requested = plan.cells.reduce((total, cell) => {
    const weightedDeadline = Math.max(
      ...cell.jobs.map((job) => job.minutes * RUNNER_MULTIPLIER[job.runner]),
    );
    return total + weightedDeadline;
  }, 0);
  const remaining = Math.max(0, PRIVATE_INCLUDED_MINUTES - used);
  if (requested > remaining) {
    throw new Error(
      `private Actions minutes are insufficient: used=${used} included=${PRIVATE_INCLUDED_MINUTES} remaining=${remaining} requested=${requested}`,
    );
  }
}

export async function readPrivateActionsMinutes(
  repository: string,
  token: string,
  now: number,
  ghScratch: string,
): Promise<number> {
  const output = await new Deno.Command("bash", {
    args: [
      "ops/private-actions-minutes.sh",
      new Date(now).toISOString().slice(0, 7) + "-01",
    ],
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      GH_TOKEN: token,
      GH_REPO: repository,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_CONFIG_DIR: ghScratch + "/config",
      XDG_STATE_HOME: ghScratch + "/state",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  return output.success && /^(0|[1-9][0-9]*)$/.test(stdout)
    ? Number(stdout)
    : NaN;
}
