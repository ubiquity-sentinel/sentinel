// @ts-check

import * as core from "@actions/core";
import { createAppAuth } from "@octokit/auth-app";

import { getPermissionsFromInputs } from "./lib/get-permissions-from-inputs.js";
import { main } from "./lib/main.js";
import request, { ensureNativeProxySupport } from "./lib/request.js";

if (!process.env.GITHUB_REPOSITORY) {
  throw new Error("GITHUB_REPOSITORY missing, must be set to '<owner>/<repo>'");
}

if (!process.env.GITHUB_REPOSITORY_OWNER) {
  throw new Error("GITHUB_REPOSITORY_OWNER missing, must be set to '<owner>'");
}

async function run() {
  ensureNativeProxySupport();

  const clientId = core.getInput("client-id") || core.getInput("app-id");
  if (!clientId) {
    throw new Error(
      "The 'client-id' (or deprecated 'app-id') input must be set to a non-empty string. If using a secret or variable, ensure it is available in this workflow context.",
    );
  }
  const privateKey = core.getInput("private-key");
  if (!privateKey) {
    throw new Error(
      "The 'private-key' input must be set to a non-empty string. If using a secret or variable, ensure it is available in this workflow context.",
    );
  }
  const enterprise = core.getInput("enterprise");
  const owner = core.getInput("owner");
  const repositories = core
    .getInput("repositories")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((x) => x !== "");

  const skipTokenRevoke = core.getBooleanInput("skip-token-revoke");
  // Sentinel adaptation: unset (or anything but "true") is the upstream mint.
  const tolerateInaccessible =
    core.getInput("tolerate-inaccessible-repositories") === "true";
  // Only removes listed names, and only for a tolerant mint.
  const knownUnavailable = core.getInput("known-unavailable");

  const permissions = getPermissionsFromInputs(process.env);

  return await main(
    clientId,
    privateKey,
    enterprise,
    owner,
    repositories,
    permissions,
    core,
    createAppAuth,
    request,
    skipTokenRevoke,
    tolerateInaccessible,
    knownUnavailable,
  );
}

// Export promise for testing
export default run().catch(() => {
  core.setFailed("Sentinel App token mint failed");
});
