/**
 * Deno grants the owner-installed release bridge forced command must carry so
 * a pinned ai.ubq.fi driver at or after ubiquity/ai.ubq.fi#1162 (6c3afe42) can
 * run its locked operations, metrics checkpoints and journal reads
 * (ubiquity-sentinel/sentinel#162). These add to the bridge's own installation,
 * state and network grants. The owner installs the flags; nothing here selects
 * or widens them at run time.
 */
export interface VpsReleaseBridgeDriverGrantsV1 {
  /** `--allow-sys=uid`: the deploy lock must be owned by `Deno.uid()`. */
  sys: readonly ["uid"];
  /** Unscoped `--allow-run`: `Deno.Command` and `node:child_process` children. */
  run: "unscoped";
  /** Read on the target root: the store's `realpath(<root>)` check. */
  read: readonly ["<root>"];
  /** Write on `<root>/.data`: deploy lock, journal, releases, checkpoints. */
  write: readonly ["<root>/.data"];
  /** Deno's `node:child_process` reads it even when the child env is explicit. */
  env: readonly ["NODE_V8_COVERAGE"];
  /** Sparse command mode, used only by release payload preparation. */
  sparsePreparationEnv: readonly ["PATH"];
  /** The Deno deploy lock polls `FsFile.tryLockSync(true)`. */
  denoApis: readonly ["FsFile.prototype.tryLockSync"];
  /** Upstream verified the Deno lock on this Deno release. */
  verifiedDeno: "2.9.7";
}
export const VPS_RELEASE_BRIDGE_DRIVER_GRANTS: VpsReleaseBridgeDriverGrantsV1 =
  {
    sys: ["uid"],
    run: "unscoped",
    read: ["<root>"],
    write: ["<root>/.data"],
    env: ["NODE_V8_COVERAGE"],
    sparsePreparationEnv: ["PATH"],
    denoApis: ["FsFile.prototype.tryLockSync"],
    verifiedDeno: "2.9.7",
  };

/** The exact `deno run` permission flags the grants above denote for one root. */
export function vpsReleaseBridgeDriverDenoFlags(
  targetRoot: string,
  options: { sparsePreparation: boolean },
): string[] {
  if (!targetRoot.startsWith("/") || targetRoot.includes(",")) {
    throw new TypeError("VPS release bridge target root is invalid");
  }
  const grants = VPS_RELEASE_BRIDGE_DRIVER_GRANTS;
  const path = (template: string) => template.replace("<root>", targetRoot);
  const env = [
    ...grants.env,
    ...(options.sparsePreparation ? grants.sparsePreparationEnv : []),
  ];
  return [
    `--allow-sys=${grants.sys.join(",")}`,
    "--allow-run",
    `--allow-read=${grants.read.map(path).join(",")}`,
    `--allow-write=${grants.write.map(path).join(",")}`,
    `--allow-env=${env.join(",")}`,
  ];
}
