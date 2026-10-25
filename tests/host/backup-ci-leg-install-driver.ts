/**
 * Driver for `backup-ci-leg-install_test.ts`: the REAL `legInstall` with the
 * REAL production dependencies, run by the test as a subprocess under the
 * leg workflow's exact Deno flags. Only the download is faked: it answers the
 * synthetic archive named by `BACKUP_TEST_ARCHIVE`, and the launcher root is
 * `BACKUP_TEST_LAUNCHER` (its pins file binds that archive).
 */
import { legInstall } from "../../ops/backup-ci-leg.ts";
import { productionLegDeps, safeEnv } from "../../ops/backup-ci-leg-host.ts";
import { createBackupCiGit } from "../../ops/backup-ci-materialize.ts";

const archive = Deno.args[0];
const launcherRoot = Deno.args[1];
const deps = {
  ...productionLegDeps(createBackupCiGit(`${safeEnv("RUNNER_TEMP")}/home`)),
  launcherRoot,
  fetch:
    (() =>
      Deno.readFile(archive).then((bytes) =>
        new Response(bytes, { status: 200 })
      )) as typeof fetch,
};
Deno.exit(await legInstall(deps));
