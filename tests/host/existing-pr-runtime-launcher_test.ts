import { DORMANT_HOSTED_SUPERVISOR_POLICY as dormant } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { ReviewOwnerCustodyBroker } from "../../src/host/review-owner-custody.ts";
import { runHostedRuntimeLauncher } from "../../src/host/hosted-runtime-launcher.ts";
import { HOSTED_RUNTIME_CHILD_ENTRYPOINT } from "../../src/host/hosted-runtime-identity.ts";
import { revalidateHostedRuntimeCompatibility } from "../../src/host/hosted-runtime-compatibility-authority.ts";
import {
  childLine,
  exited,
  makeRig,
  OTHER_REVISION,
  seedRelease,
} from "./hosted-runtime-fixture.ts";
import { runProof } from "./actions-supervisor-fixture.ts";
const policy = (revisions: readonly GitSha[]) => ({
  custodyActivated: true,
  revisions,
});
Deno.test("existing PR runtime fence: actual launcher blocks all purposes and matrix replay before child or review custody starts", async (t) => {
  const cases = [
    ["repair", "ordinary"],
    ["repair", "bootstrap"],
    ["repair", "prior"],
    ["repair", "candidate"],
    ["repair", "rollback"],
    ["matrix_plan", "ordinary"],
    ["matrix_cell", "ordinary"],
  ] as const;
  for (const [job, purpose] of cases) {
    await t.step(`${job}/${purpose}`, async () => {
      const rig = await makeRig();
      try {
        rig.execution = parseHostedExecutionIntentV1({
          ...rig.execution,
          purpose,
          releaseId: ["prior", "candidate", "rollback"].includes(purpose)
            ? "release-fixture"
            : null,
        });
        await seedRelease(rig);
        const before = await rig.release.readRelease();
        let custodyStarts = 0;
        const broker = purpose === "ordinary"
          ? new ReviewOwnerCustodyBroker(rig.execution, [{
            repository: {
              owner: "ubiquity",
              name: "sentinel",
              installationId: 0,
            },
            provider: "fixture",
            model: "fixture",
            permissionProfile: "fixture",
            session: {
              command: ["never-start"],
              cwd: rig.runtimeDir,
              env: {},
              operationDeadlineMs: 1000,
            },
          }])
          : undefined;
        if (broker !== undefined) {
          broker.start = () => {
            custodyStarts++;
            return Promise.reject(new Error("custody must not start"));
          };
        }
        const result = await runHostedRuntimeLauncher(
          {
            state: rig.release,
            clock: rig.clock,
            env: { ...rig.env, GITHUB_JOB: job },
            launcherDir: rig.launcherDir,
            runtimeDir: rig.runtimeDir,
            denoExecutable: Deno.execPath(),
            process: rig.process,
            reviewCustody: broker,
          },
          dormant.queue,
          {
            ...policy([OTHER_REVISION]),
            ownerInstallMigrations: [{
              fromRevision: rig.execution.revision,
              fromGeneration: 1,
              toRevision: OTHER_REVISION,
              toGeneration: 2,
            }],
          },
        );
        assert.equal(result.status, "unavailable");
        assert.equal(result.terminal, null);
        assert.equal(
          rig.process.calls.filter((call) =>
            call.args.includes(HOSTED_RUNTIME_CHILD_ENTRYPOINT) ||
            call.args.includes("src/host/matrix-actions.ts")
          ).length,
          0,
        );
        assert.equal(custodyStarts, 0);
        assert.deepEqual(await rig.release.readRelease(), before);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("existing PR runtime fence: exact accepted runtime runs from a different launcher SHA", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    assert.notEqual(rig.identity.launcherSha, rig.execution.revision);
    rig.process.child = exited(childLine(rig.execution));
    const result = await runHostedRuntimeLauncher(
      {
        state: rig.release,
        clock: rig.clock,
        env: rig.env,
        launcherDir: rig.launcherDir,
        runtimeDir: rig.runtimeDir,
        denoExecutable: Deno.execPath(),
        process: rig.process,
      },
      dormant.queue,
      policy([rig.execution.revision]),
    );
    assert.equal(result.status, "healthy");
    assert.equal(rig.process.childCalls().length, 1);
    assert.equal(result.terminal?.execution.revision, rig.execution.revision);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime fence: fresh authority rejects dormant policy, changed execution and state races", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthyRead = async () => {
      const read = await rig.release.readRelease();
      assert.ok(read.ok && read.value.status === "found");
      read.value.snapshot.hostedRuntimes[0].lastHealthyProof = runProof(
        parseHostedExecutionIntentV1({
          ...rig.execution,
          id: "6:1:repair",
          runId: 6,
          runAttempt: 1,
          purpose: "bootstrap",
          createdAt: rig.execution.createdAt - 4000,
        }),
        "healthy",
      );
      return read;
    };
    const input = {
      state: { readRelease: healthyRead },
      clock: rig.clock,
      identity: rig.identity,
      execution: rig.execution,
      controllerSha: rig.execution.revision,
      deadline: rig.clock.now() + 1000,
    };
    assert.equal(
      (await revalidateHostedRuntimeCompatibility(
        input,
        dormant.queue,
        dormant.custody,
      )).ok,
      false,
    );
    assert.equal(
      (await revalidateHostedRuntimeCompatibility(
        { ...input, state: rig.release },
        dormant.queue,
        policy([rig.execution.revision]),
      )).ok,
      false,
      "own health is required",
    );
    assert.equal(
      (await revalidateHostedRuntimeCompatibility(
        input,
        dormant.queue,
        policy([rig.execution.revision]),
      )).ok,
      true,
    );
    assert.equal(
      (await revalidateHostedRuntimeCompatibility(
        { ...input, execution: { ...rig.execution, purpose: "bootstrap" } },
        dormant.queue,
        policy([rig.execution.revision]),
      )).ok,
      false,
    );
    assert.equal(
      (await revalidateHostedRuntimeCompatibility(
        {
          ...input,
          identity: {
            ...rig.identity,
            runAttempt: rig.identity.runAttempt + 1,
          },
        },
        dormant.queue,
        policy([rig.execution.revision]),
      )).ok,
      false,
    );
    assert.equal(
      (await revalidateHostedRuntimeCompatibility(
        { ...input, identity: { ...rig.identity, job: "matrix_cell" } },
        dormant.queue,
        policy([rig.execution.revision]),
      )).ok,
      false,
    );
    const read = await healthyRead();
    assert.ok(read.ok && read.value.status === "found");
    let reads = 0;
    const raced = {
      ...input,
      state: {
        readRelease: () => {
          reads++;
          return Promise.resolve(
            reads === 1
              ? read
              : { ...read, value: { ...read.value, head: OTHER_REVISION } },
          );
        },
      },
    };
    assert.equal(
      (await revalidateHostedRuntimeCompatibility(
        raced,
        dormant.queue,
        policy([rig.execution.revision]),
      )).ok,
      false,
    );
    assert.equal(
      (await revalidateHostedRuntimeCompatibility(input, {
        proofActivated: true,
        revisions: [],
      }, policy([rig.execution.revision]))).ok,
      false,
    );
  } finally {
    await rig.cleanup();
  }
});
