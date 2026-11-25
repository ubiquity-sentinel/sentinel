/** The late private cell's next maintenance pass, between two native runs. */
import assert from "node:assert/strict";
import { recoverHostedCurrentMatrix } from "../../ops/hosted-autonomy-current-recovery.ts";
import { createHostedClosedMatrixRecovery } from "../../ops/hosted-autonomy-matrix-adapters.ts";
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import type { MatrixPlanReportV1 } from "../../src/host/matrix.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { createFreshMatrixArchives } from "./matrix-actions-archive-fixtures.ts";
import {
  checked,
  type rig,
  type TargetGithub,
} from "./matrix-actions-fixtures.ts";
import {
  advanceWithLog,
  QUIET_LOG,
  quietly,
  reply,
} from "./targets-deferral-fixtures.ts";

export async function recoverLatePrivateCell(
  r: Awaited<ReturnType<typeof rig>>,
  planner: MatrixPlanReportV1 & { planDigest: string },
  result: MatrixCellResultV1,
  archive: string,
  sourceDir: string,
  repositoryHttp: HttpTransportV1,
  github: TargetGithub,
) {
  const files = await createFreshMatrixArchives(
    r,
    planner,
    [result],
    archive,
    true,
    false,
    true,
  );
  const scratch = r.root + "/maintenance";
  const target = `${result.repository.owner}/${result.repository.name}`;
  const mirror = scratch + "/sources/" + target.replace("/", "-");
  const metadata: string[] = [];
  await advanceWithLog(r, 72, QUIET_LOG, 101, async () => {
    const released = await r.release.readRelease();
    assert.ok(released.ok && released.value.status === "found");
    const proof = released.value.snapshot.hostedRuntimes[0].lastExecutionProof;
    assert.ok(proof && proof.outcome !== "not_started");
    const recover = (targetAvailable: boolean) =>
      recoverHostedCurrentMatrix(
        {
          state: r.store,
          clock: r.clock,
          ciMinutes: INACTIVE_CI_MINUTES,
          githubFor: () => null,
          closedMatrix: async (state = r.store) => {
            const recovery = await createHostedClosedMatrixRecovery({
              state,
              clock: r.clock,
              sourceDir,
              scratch,
              artifactRoot: scratch + "/artifacts",
              token: "fake-read-token",
              apiToken: "fake-app-token",
              cooldownMode: "off",
              http: (request) => {
                const path = new URL(request.url).pathname;
                if (!targetAvailable && path === `/repos/${target}`) {
                  return reply(404)();
                }
                if (path === `/repos/${target}/commits/development`) {
                  return reply(
                    200,
                    {},
                    JSON.stringify({ sha: r.foreignSha }),
                  )();
                }
                if (path === `/repos/${target}/contents`) {
                  return reply(200, {}, "[]")();
                }
                if (
                  path === `/repos/${target}/contents/.github/workflows`
                ) {
                  return reply(404)();
                }
                metadata.push(
                  `${path} ${request.headers.get("authorization")}`,
                );
                return repositoryHttp(request);
              },
              artifactHttp: files.artifactHttp(
                () => true,
                undefined,
                "completed",
              ),
            });
            return {
              ...recovery,
              // The external native settlement and target repository are fixtures.
              readExecution: () => Promise.resolve(portOk(proof)),
              prepareTarget: async () => {
                await checked(r.root, [
                  "clone",
                  "-q",
                  r.root + "/foreign",
                  mirror,
                ], r.env);
              },
              cycleFor: (config) => ({ ...recovery.cycleFor(config), github }),
            };
          },
        },
        CLOSED_C_WAVE,
        () => assert.fail("late cell unexpectedly deferred"),
      );
    const unavailable = await quietly(() => recover(false));
    assert.equal(unavailable.value, null);
    assert.ok(
      unavailable.lines.some((line) =>
        line.includes('"reason":"no_matching_target_config"')
      ),
    );
    assert.equal(files.artifactCalls.length, 0);
    const recovered = await recover(true);
    assert.deepEqual(recovered?.actions, ["current-matrix:ingested:1"]);
    const read = await r.store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const work = read.value.snapshot.work.find((row) =>
      row.id === result.taskId
    );
    assert.equal(
      work?.target.candidateState?.preserved?.head,
      result.bundle!.head,
    );
    assert.equal(work?.intent, null);
    assert.equal(
      read.value.snapshot.reservations.find((row) =>
        row.id === result.reservationId
      )?.outcome,
      "submitted",
    );
  });
  assert.ok(
    metadata.includes(
      "/repos/ubiquity-sentinel-private/sentinel Bearer fake-read-token",
    ),
  );
  assert.ok(metadata.includes(`/repos/${target} Bearer fake-app-token`));
  assert.ok(
    files.artifactCalls.some((url) => url.includes("/runs/71/artifacts?")),
  );
}
