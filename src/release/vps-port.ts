import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import type { VpsReleasePortV1 } from "../contracts/ports-vps-release.ts";
import { parseVpsInference } from "../contracts/vps-release.ts";
import {
  parseVpsHealth,
  parseVpsReceipt,
  parseVpsSample,
  parseVpsSelector,
  type VpsHealthProof,
  type VpsIdentity,
  type VpsInferenceProof,
  type VpsMetricsSample,
  type VpsMutation,
  type VpsOperation,
  type VpsPrepare,
  type VpsReceipt,
  type VpsSelector,
  type VpsSettlement,
} from "../contracts/vps-release-wire.ts";

export interface NativeVpsDriverV1 {
  inspectPrior(): Promise<VpsSelector>;
  prepare(input: VpsPrepare): Promise<VpsReceipt>;
  activate(input: VpsMutation): Promise<VpsReceipt>;
  observe(input: VpsOperation): Promise<VpsReceipt>;
  restore(input: VpsMutation): Promise<VpsReceipt>;
  settle(input: VpsSettlement): Promise<VpsReceipt>;
  sampleHealth(
    identity: VpsIdentity,
    surface: "loopback" | "public",
    port?: number,
  ): Promise<VpsHealthProof>;
}
export interface VpsPortOptionsV1 {
  driver: NativeVpsDriverV1;
  metrics: {
    sample(
      input: { identity: VpsIdentity; windowStart: number; windowEnd: number },
    ): Promise<VpsMetricsSample>;
  };
  readInferenceProof(identity: VpsIdentity): Promise<VpsInferenceProof | null>;
}
async function guarded<T>(
  work: () => Promise<unknown>,
  parse: (value: unknown) => T,
): Promise<PortResultV1<T>> {
  try {
    return portOk(parse(await work()));
  } catch {
    return portError("unavailable", "VPS release capability is unavailable");
  }
}
/** Parses real producer outputs; injected capabilities do not constitute a production transport. */
export function composeVpsReleasePort(
  options: VpsPortOptionsV1,
): VpsReleasePortV1 {
  return {
    inspectPrior: () =>
      guarded(() => options.driver.inspectPrior(), parseVpsSelector),
    prepare: (input) =>
      guarded(() => options.driver.prepare(input), parseVpsReceipt),
    activate: (input) =>
      guarded(() => options.driver.activate(input), parseVpsReceipt),
    observe: (input) =>
      guarded(() => options.driver.observe(input), parseVpsReceipt),
    restore: (input) =>
      guarded(() => options.driver.restore(input), parseVpsReceipt),
    settle: (input) =>
      guarded(() => options.driver.settle(input), parseVpsReceipt),
    sampleHealth: (identity, surface, port) =>
      guarded(
        () => options.driver.sampleHealth(identity, surface, port),
        parseVpsHealth,
      ),
    sampleMetrics: (input) =>
      guarded(() => options.metrics.sample(input), parseVpsSample),
    readInferenceProof: (identity) =>
      guarded(
        () => options.readInferenceProof(identity),
        (value) => value === null ? null : parseVpsInference(value),
      ),
  };
}

export interface PinnedVpsDriverModuleV1 {
  createVpsDeploymentDriver(deps: unknown): NativeVpsDriverV1;
}
/** Every byte in the immutable driver release is verified BEFORE evaluating its module. */
export async function loadPinnedVpsDriver(
  input: { releaseRoot: string; identity: VpsIdentity; moduleSha256: string },
): Promise<PinnedVpsDriverModuleV1> {
  const { parseVpsIdentity, sha256 } = await import(
    "../contracts/vps-release-wire.ts"
  );
  const identity = parseVpsIdentity(input.identity);
  if (
    await Deno.realPath(input.releaseRoot) !== input.releaseRoot ||
    !input.releaseRoot.endsWith(`/releases/${identity.gitSha}`)
  ) throw new TypeError("Pinned VPS driver root is invalid");
  const digest = async (bytes: Uint8Array): Promise<string> => {
    const inputBytes = new Uint8Array(bytes.byteLength);
    inputBytes.set(bytes);
    return [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", inputBytes)),
    ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const entries: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const names: string[] = [];
    for await (
      const entry of Deno.readDir(`${input.releaseRoot}/${relative}`)
    ) names.push(entry.name);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name,
        full = `${input.releaseRoot}/${path}`,
        stat = await Deno.lstat(full),
        mode = (stat.mode ?? 0) & 0o777;
      if (stat.isSymlink) {
        throw new TypeError("Pinned VPS driver tree has a symlink");
      }
      if (stat.isFile) {
        entries.push(
          JSON.stringify([
            path,
            "file",
            mode,
            await digest(await Deno.readFile(full)),
          ]),
        );
      } else if (stat.isDirectory) {
        entries.push(JSON.stringify([path, "directory", mode]));
        await walk(path);
      } else {throw new TypeError(
          "Pinned VPS driver tree has an unsupported entry",
        );}
    }
  };
  await walk("");
  if (
    await digest(new TextEncoder().encode(entries.join("\n"))) !==
      identity.immutableTreeSha256
  ) throw new TypeError("Pinned VPS driver tree identity changed");
  const modulePath = `${input.releaseRoot}/ops/vps-release-driver.ts`;
  if (
    await digest(await Deno.readFile(modulePath)) !== sha256(input.moduleSha256)
  ) throw new TypeError("Pinned VPS driver module identity changed");
  const module = await import(
    new URL(`file://${modulePath}`).href
  ) as PinnedVpsDriverModuleV1;
  if (typeof module.createVpsDeploymentDriver !== "function") {
    throw new TypeError("Pinned VPS driver ABI is unavailable");
  }
  return module;
}
