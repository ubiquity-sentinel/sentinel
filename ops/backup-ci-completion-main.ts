/** Unprivileged workflow_run router. It reads plans, never artifacts or secrets. */
import {
  BACKUP_CI_STORE_REMOTE,
  backupCiCommitPath,
  parseBackupCiCommitFile,
} from "../src/contracts/backup-ci.ts";
import {
  routeBackupCiCompletion,
  routeControllerCiCompletion,
} from "../src/host/backup-ci-completion.ts";
import { createBackupCiGit } from "./backup-ci-materialize.ts";
import { createBackupCiApi } from "./backup-ci-plan-reads.ts";
import { openBackupCiStore } from "./backup-ci-store-writer.ts";

export async function backupCiCompletionMain(): Promise<void> {
  const token = Deno.env.get("GITHUB_TOKEN") ?? "";
  const eventPath = Deno.env.get("GITHUB_EVENT_PATH") ?? "";
  const temp = Deno.env.get("RUNNER_TEMP") ?? "";
  if (
    token === "" || !eventPath.startsWith("/") || !temp.startsWith("/") ||
    Deno.env.get("GITHUB_EVENT_NAME") !== "workflow_run"
  ) throw new Error("backup CI completion context unavailable");
  const info = await Deno.stat(eventPath);
  if (!info.isFile || info.size > 1024 * 1024) {
    throw new Error("backup CI completion event unavailable");
  }
  const event: unknown = JSON.parse(await Deno.readTextFile(eventPath));
  const api = createBackupCiApi(token);
  let store: Awaited<ReturnType<typeof openBackupCiStore>> | undefined;
  const leg = () =>
    routeBackupCiCompletion(event, {
      api,
      async dispatched(unitId) {
        store ??= await openBackupCiStore({
          git: createBackupCiGit(`${temp}/backup-ci-completion/git-home`),
          scratch: `${temp}/backup-ci-completion/store`,
          remote: BACKUP_CI_STORE_REMOTE,
        });
        const entries = [];
        for (const path of await store.pathsContaining(unitId, "v1/", 2)) {
          const file = parseBackupCiCommitFile(await store.read(path));
          if (
            path !== backupCiCommitPath(
              file.repository.owner,
              file.repository.name,
              file.commit,
            )
          ) throw new Error("backup CI completion plan path mismatch");
          entries.push(
            ...file.entries.filter((entry) =>
              entry.state === "dispatched" && entry.unit.unitId === unitId
            ),
          );
        }
        return entries.filter((entry) => entry.state === "dispatched");
      },
    });
  const result =
    (event as { workflow_run?: { path?: unknown } })?.workflow_run?.path ===
        ".github/workflows/ci.yml"
      ? await routeControllerCiCompletion(event, api)
      : await leg();
  console.log(JSON.stringify({ event: "backup_ci_completion", ...result }));
  if (result.decision === "unavailable") Deno.exitCode = 1;
}

if (import.meta.main) await backupCiCompletionMain();
