import assert from "node:assert/strict";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import {
  CANDIDATE,
  DORMANT_HOSTED_POLICIES,
  LAUNCHER,
  makeRig,
  releaseRequest,
  requireRun,
  reviewReceipt,
  ROOT,
  run,
  runProof,
} from "./actions-supervisor-fixture.ts";
import { R80_RUNTIME, r80Available } from "./r80-contracts.ts";

const available = await r80Available();

Deno.test({
  name:
    "queue runtime capability: actual R80 parses every accepted runtime lifecycle write",
  ignore: !available,
  fn: async () => {
    const directory = await Deno.makeTempDir({
      dir: ROOT,
      prefix: "sentinel-queue-capability-r80-",
    });
    const rig = await makeRig();
    const env = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    try {
      const archive = await new Deno.Command("git", {
        args: [
          "-C",
          ROOT,
          "archive",
          "--format=tar",
          R80_RUNTIME,
          "src/contracts",
        ],
        clearEnv: true,
        env,
        stdout: "piped",
        stderr: "null",
      }).output();
      assert.ok(archive.success);
      await Deno.writeFile(`${directory}/tree.tar`, archive.stdout);
      const extracted = await new Deno.Command("tar", {
        args: ["-xf", `${directory}/tree.tar`, "-C", directory],
        clearEnv: true,
        env,
        stdout: "null",
        stderr: "null",
      }).output();
      assert.ok(extracted.success);
      const r80 = await import(
        new URL(`file://${directory}/src/contracts/state-snapshots.ts`).href
      );
      let writes = 0;
      const input = (id: number) => ({
        ...DORMANT_HOSTED_POLICIES,
        clock: rig.clock,
        run: run(id),
        evidence: rig.evidence,
        queueRuntimeCapability: {
          proofActivated: true,
          revisions: [LAUNCHER, CANDIDATE],
        },
        state: {
          readRelease: rig.release.readRelease.bind(rig.release),
          readRepair: rig.release.readRepair.bind(rig.release),
          writeRelease: (
            next: Parameters<typeof rig.release.writeRelease>[0],
            head: Parameters<typeof rig.release.writeRelease>[1],
          ) => {
            writes++;
            assert.deepEqual(
              r80.parseReleaseStateSnapshotV1(JSON.parse(JSON.stringify(next))),
              next,
            );
            return rig.release.writeRelease(next, head);
          },
        },
      });
      rig.evidence.revisions.add(LAUNCHER);
      const boot = requireRun(await runHostedSupervisorPrepare(input(1)));
      rig.evidence.settlements.set(boot.id, runProof(boot, "healthy"));
      await runHostedSupervisorFinalize(input(1));
      const request = releaseRequest();
      await rig.seedRepair([request], [reviewReceipt(request)]);
      rig.evidence.requests.add(request.id);
      const prior = requireRun(await runHostedSupervisorPrepare(input(2)));
      rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
      const candidate = requireRun(await runHostedSupervisorPrepare(input(3)));
      rig.evidence.settlements.set(candidate.id, runProof(candidate, "failed"));
      const rollback = requireRun(await runHostedSupervisorPrepare(input(4)));
      rig.evidence.settlements.set(rollback.id, runProof(rollback, "healthy"));
      await runHostedSupervisorFinalize(input(4));
      const ordinary = requireRun(await runHostedSupervisorPrepare(input(5)));
      assert.equal(ordinary.purpose, "ordinary");
      assert.ok(
        writes >= 12,
        "all intents, pointer movements, settlements and final ordinary execution pass R80",
      );
    } finally {
      await rig.cleanup();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
