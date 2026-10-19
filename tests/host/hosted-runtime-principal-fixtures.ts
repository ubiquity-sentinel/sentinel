/** Real launcher/runtime Git and owned children with synthetic native HTTP. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseHostedAppSourceProfiles } from "../../src/host/hosted-app-principal-source.ts";
import type { HostedRuntimeLauncherInputV1 } from "../../src/host/hosted-runtime-identity.ts";
import { HOSTED_RUNTIME_WORKFLOW_REF } from "../../src/host/hosted-runtime-identity.ts";
import { runHostedRuntimeLauncher } from "../../src/host/hosted-runtime-launcher.ts";
import { principalHostFixture } from "./hosted-app-principal-fixtures.ts";
import { BorderRuntime } from "./hosted-runtime-fixture.ts";
import { runProof } from "./actions-supervisor-fixture.ts";
import { OBSERVED } from "../github/hosted-execution-helpers.ts";

export async function principalLauncherFixture(
  grantExpected: boolean,
  job: "repair" | "matrix_plan" | "matrix_cell" = "repair",
  tokenKind: "app" | "native" | "absent" = "app",
) {
  const rig = await principalHostFixture();
  const appToken = tokenKind === "app"
    ? rig.scopeInput.token
    : tokenKind === "native"
    ? rig.jobInput.token
    : undefined;
  const expected = {
    GITHUB_TOKEN: rig.jobInput.token,
    SENTINEL_SUPERVISOR_TOKEN: appToken,
    SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: grantExpected
      ? rig.hostInput.mintGrant
      : undefined,
    SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER:
      appToken !== undefined && job !== "matrix_cell"
        ? String(OBSERVED + 58 * 60_000)
        : undefined,
  };
  const script = [
    "const expected = " + JSON.stringify(expected) + ";",
    "for (const key of ['GITHUB_TOKEN', 'SENTINEL_SUPERVISOR_TOKEN', 'SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT', 'SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER', 'SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE']) {",
    "  if (Deno.env.get(key) !== expected[key]) throw new Error('fixture child handoff mismatch');",
    "}",
    "const command = new Deno.Command('/usr/bin/git', { args: ['rev-parse', 'HEAD'], stdout: 'piped', stderr: 'piped' }).outputSync();",
    "if (!command.success) throw new Error('fixture child source unavailable');",
    "const revision = new TextDecoder().decode(command.stdout).trim();",
    "const run = { runId: Number(Deno.env.get('GITHUB_RUN_ID')), runAttempt: Number(Deno.env.get('GITHUB_RUN_ATTEMPT')), launcherSha: Deno.env.get('GITHUB_SHA') };",
    "const execution = { ..." + JSON.stringify(rig.execution) +
    ", ...run, revision };",
    "if (Deno.env.get('GITHUB_JOB') === 'repair') {",
    "  console.log(JSON.stringify({ status: 'ran', outcome: { status: 'idle', detail: 'fixture' }, controllerSha: revision, baseSha: revision, login: 'github-actions[bot]', startupReady: true, ciApproval: { approved: 0, pending: 0, unavailable: 0 }, execution }));",
    "} else if (Deno.env.get('GITHUB_JOB') === 'matrix_plan') {",
    "  console.log(JSON.stringify({ kind: 'sentinel_matrix_plan', waveId: execution.id, run, runtimeSha: revision, generation: execution.generation, planDigest: 'd'.repeat(64), prepared: 1 }));",
    "} else {",
    "  console.log(JSON.stringify({ kind: 'sentinel_matrix_cell', run, runtimeSha: revision, generation: execution.generation, cellId: 'c'.repeat(64), reservationId: 'fixture-reservation', resultDigest: 'e'.repeat(64), bundleDigest: 'f'.repeat(64), status: 'completed' }));",
    "}",
  ].join("\n");
  await rig.write(rig.launcher, ".gitignore", ".sentinel/\n");
  await rig.write(rig.runtime, ".gitignore", ".sentinel/\n");
  await rig.write(rig.runtime, "src/host/actions.ts", script);
  await rig.write(rig.runtime, "src/host/matrix-actions.ts", script);
  await rig.git(rig.runtime, ["add", "."]);
  await rig.git(rig.runtime, ["commit", "-qm", "fixture owned child"]);
  const revision = await rig.git(rig.runtime, ["rev-parse", "HEAD"]) as GitSha;
  rig.execution.revision = revision;
  rig.capability.existingPr.revisions = [revision];
  await rig.write(
    rig.launcher,
    "src/host/hosted-custody-capability.json",
    JSON.stringify(rig.capability),
  );
  const release = parseReleaseStateSnapshotV1(rig.state.release!.snapshot);
  release.hostedRuntimes[0].activeRevision = revision;
  release.hostedRuntimes[0].execution = structuredClone(rig.execution);
  const healthy = release.hostedRuntimes[0].lastHealthyProof;
  assert(healthy !== null);
  release.hostedRuntimes[0].lastHealthyProof = runProof({
    ...healthy.execution,
    revision,
  }, "healthy");
  rig.state.setRelease(release);
  await rig.commitLauncher();
  rig.identity.job = job;
  if (job === "matrix_plan") {
    rig.model.jobs[0].name = job;
    const steps = rig.model.jobs[0].steps as Array<{ name: string }>;
    steps[2].name = rig.profiles[0].jobs.matrix_plan.runtimeStep;
  }
  const process = new BorderRuntime();
  process.realChild = true;
  const input: HostedRuntimeLauncherInputV1 = {
    state: {
      readRelease: rig.state.readRelease.bind(rig.state),
      readRepair: rig.state.readRepair.bind(rig.state),
    },
    clock: rig.clock,
    env: {
      GITHUB_RUN_ID: String(rig.identity.runId),
      GITHUB_RUN_ATTEMPT: String(rig.identity.runAttempt),
      GITHUB_REPOSITORY: "ubiquity/sentinel",
      GITHUB_REF: "refs/heads/sentinel-supervisor",
      GITHUB_SHA: rig.identity.launcherSha,
      GITHUB_WORKFLOW_SHA: rig.identity.launcherSha,
      GITHUB_WORKFLOW_REF: HOSTED_RUNTIME_WORKFLOW_REF,
      GITHUB_JOB: job,
      GITHUB_TOKEN: rig.jobInput.token,
      SENTINEL_SUPERVISOR_TOKEN: appToken,
      SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: rig.hostInput.mintGrant,
      SENTINEL_SUPERVISOR_TOKEN_MINTED_NOT_BEFORE: String(OBSERVED),
      UOS_AI_TOKEN: "fixture-model-token",
      PATH: Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: rig.root,
      ...(job === "matrix_plan" ? { GITHUB_OUTPUT: rig.root + "/output" } : {}),
    },
    launcherDir: rig.launcher,
    runtimeDir: rig.runtime,
    denoExecutable: Deno.execPath(),
    process,
    principalHandoffFixture: {
      http: rig.jobInput.http,
      sourceProfiles: parseHostedAppSourceProfiles(rig.profiles),
    },
    ...(job === "matrix_cell"
      ? {
        stdin: JSON.stringify({
          planDigest: "d".repeat(64),
          cellId: "c".repeat(64),
        }),
      }
      : {}),
  };
  return {
    ...rig,
    process,
    input,
    launch: () =>
      runHostedRuntimeLauncher(
        input,
        rig.capability.queue,
        rig.capability.existingPr,
      ),
    childCalls: () =>
      process.calls.filter((call) => call.executable === Deno.execPath()),
  };
}
