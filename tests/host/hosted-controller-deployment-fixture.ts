/** Counterfactual committed placement; production modules have no override. */
import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HOSTED_CONTROLLER_DEPLOYMENT,
} from "../../src/contracts/hosted-controller-deployment.ts";
import { gitRun, makeRemoteCtx, testGitEnv } from "../state/helpers.ts";

export const PRIVATE_REPOSITORY =
  "Ubiquity-Sentinel/sentinel-controller-fixture";
export const PRIVATE_SUPERVISOR_ID = 791001;
export const PRIVATE_CI_ID = 791002;

export async function privateControllerFixture() {
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = source + ".sentinel-artifacts";
  await Deno.mkdir(scratch, { recursive: true });
  const root = await Deno.makeTempDir({ dir: scratch, prefix: "controller-" });
  const checkout = root + "/source";
  const env = testGitEnv(root + "/git-home");
  await Deno.mkdir(root + "/git-home", { recursive: true });
  try {
    for (const name of ["src", "ops", "tests"]) {
      await cp(source + name, checkout + "/" + name, { recursive: true });
    }
    for (const name of ["deno.json", "deno.lock"]) {
      await Deno.copyFile(source + name, checkout + "/" + name);
    }
    const binding = checkout + "/src/contracts/hosted-controller-deployment.ts";
    const original = await Deno.readTextFile(binding);
    const privateSource = original
      .replace(
        `name: "${HOSTED_CONTROLLER_DEPLOYMENT.name}",`,
        'name: "sentinel-controller-fixture",',
      )
      .replace(
        `supervisorWorkflowId: ${HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowId},`,
        `supervisorWorkflowId: ${PRIVATE_SUPERVISOR_ID},`,
      )
      .replace(
        `ciWorkflowId: ${HOSTED_CONTROLLER_DEPLOYMENT.ciWorkflowId},`,
        `ciWorkflowId: ${PRIVATE_CI_ID},`,
      );
    assert.notEqual(privateSource, original);
    await Deno.writeTextFile(binding, privateSource);
    await Deno.writeTextFile(checkout + "/.gitignore", ".sentinel/\n");
    for (
      const args of [
        ["init", "--initial-branch=development"],
        ["add", "."],
        ["commit", "-m", "Synthetic committed private controller"],
      ]
    ) assert((await gitRun(checkout, args, env)).ok);
    const head = await gitRun(checkout, ["rev-parse", "HEAD"], env);
    assert(head.ok);
    await Deno.mkdir(root + "/state");
    const remote = await makeRemoteCtx(root + "/state", env);
    const load = <T>(path: string): Promise<T> =>
      import(pathToFileURL(checkout + "/" + path).href);
    return {
      root,
      checkout,
      head: head.stdout.trim(),
      remote: remote.remoteUrl,
      load,
      close: () => Deno.remove(root, { recursive: true }),
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}
