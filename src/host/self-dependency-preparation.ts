/** Trusted host preparation only; no credential or executable target code crosses. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  copyDependencies,
  DEPENDENCY_REFUSAL,
  dependencyFiles,
  fileDigest,
  MAX_NODE_BYTES,
  realDirectory,
  refuse,
  sameGraph,
  SELF_ACTION,
  sourceFiles,
  textDigest,
} from "./self-dependency-files.ts";
import { parseSelfDependencySeed } from "./self-dependency-seed.ts";

export interface CheckoutDependenciesInputV1 {
  repository: RepositoryIdentityV1;
  checkout: string;
}
export type PrepareCheckoutDependenciesV1 = (
  input: CheckoutDependenciesInputV1,
) => Promise<PortResultV1<void>>;
export function isSentinelSelfTarget(
  repository: RepositoryIdentityV1,
): boolean {
  return repository.owner === "Ubiquity-Sentinel" &&
    repository.name === "sentinel";
}
/**
 * expectedSealSha256/sourceCommit and seedRoot must come from the protected,
 * source-authenticated launcher, never model input or an unverified env JSON.
 * Snapshot the strict parsed manifest now; callers cannot mutate its identity.
 */
export function createSelfDependencyPreparer(input: {
  seedRoot: string;
  manifestText: string;
  expectedSealSha256: string;
  sourceCommit: GitSha;
}): PrepareCheckoutDependenciesV1 {
  const manifest = parseSelfDependencySeed(input.manifestText);
  if (
    !isGitSha(input.sourceCommit) ||
    !/^[0-9a-f]{64}$/.test(input.expectedSealSha256) ||
    textDigest(input.manifestText) !== input.expectedSealSha256
  ) refuse();
  if (manifest.sourceCommit !== input.sourceCommit) refuse();
  const seedRoot = input.seedRoot;
  return async ({ repository, checkout }) => {
    if (!isSentinelSelfTarget(repository)) return portOk(undefined);
    try {
      await realDirectory(seedRoot);
      await realDirectory(checkout);
      if (
        seedRoot === checkout || checkout.startsWith(`${seedRoot}/`) ||
        seedRoot.startsWith(`${checkout}/`)
      ) refuse();
      const node = await fileDigest(manifest.node.path, MAX_NODE_BYTES);
      if (
        node.sha256 !== manifest.node.sha256 || node.size !== manifest.node.size
      ) refuse();
      const nodeMode = (await Deno.lstat(manifest.node.path)).mode;
      if (nodeMode === null || (nodeMode & 0o111) === 0) refuse();
      if (
        !sameGraph(await sourceFiles(seedRoot), manifest.source) ||
        !sameGraph(await sourceFiles(checkout), manifest.source)
      ) refuse();
      const source = `${seedRoot}/${SELF_ACTION}/node_modules`;
      if (!sameGraph(await dependencyFiles(source), manifest.dependencies)) {
        refuse();
      }
      await copyDependencies({
        source,
        action: `${checkout}/${SELF_ACTION}`,
        files: manifest.dependencies,
      });
      // Revalidate both inputs after copying before the host creates any client.
      if (
        !sameGraph(await sourceFiles(seedRoot), manifest.source) ||
        !sameGraph(await sourceFiles(checkout), manifest.source) ||
        !sameGraph(await dependencyFiles(source), manifest.dependencies)
      ) refuse();
      return portOk(undefined);
    } catch {
      return portError("unavailable", DEPENDENCY_REFUSAL);
    }
  };
}
