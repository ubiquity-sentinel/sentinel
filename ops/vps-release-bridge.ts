/** Root-installed SSH forced-command entrypoint. Stdin is the only caller input. */
import {
  authenticateReleaseBridgeJob,
  parseReleaseBridgeConfigDigest,
  parseReleaseBridgeInput,
  parseReleaseBridgeInstallation,
  readReleaseBridgeInput,
  readRootPinnedBridgeFile,
  RELEASE_BRIDGE_CAPABILITIES,
  RELEASE_BRIDGE_CONFIG,
  RELEASE_BRIDGE_CONFIG_DIGEST,
  type ReleaseBridgeCapabilities,
  type ReleaseBridgeCode,
  releaseBridgeFailure,
  type ReleaseBridgeResult,
  runReleaseBridge,
  verifyReleaseBridgeInstallation,
} from "../src/host/release-bridge.ts";

/** No argv/env/dotenv selection, shell execution, token file or public receipt. */
export async function vpsReleaseBridgeMain(): Promise<ReleaseBridgeResult> {
  if (Deno.args.length !== 0) return releaseBridgeFailure("input_rejected");
  let bytes: Uint8Array | null = null;
  let failure: ReleaseBridgeCode = "input_rejected";
  try {
    bytes = await readReleaseBridgeInput(Deno.stdin.readable);
    const input = parseReleaseBridgeInput(bytes);
    bytes.fill(0);
    failure = "installation_rejected";
    const configDigest = parseReleaseBridgeConfigDigest(
      await readRootPinnedBridgeFile(RELEASE_BRIDGE_CONFIG_DIGEST, null, 65),
    );
    const installationBytes = await readRootPinnedBridgeFile(
      RELEASE_BRIDGE_CONFIG,
      configDigest,
    );
    const pin = parseReleaseBridgeInstallation(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(installationBytes),
      ),
    );
    if (
      import.meta.url !==
        new URL(`file://${pin.controller.root}/ops/vps-release-bridge.ts`).href
    ) return releaseBridgeFailure("installation_rejected");
    await verifyReleaseBridgeInstallation(pin);
    if (input.operation === "preflight" || pin.activation === "setup_only") {
      return await runReleaseBridge(input, pin, null);
    }
    if (pin.capabilitiesSha256 === null) {
      return releaseBridgeFailure("capability_unavailable");
    }
    // The protected job/source must authenticate before any capability module evaluation.
    failure = "authentication_rejected";
    await authenticateReleaseBridgeJob(input, pin, fetch, Date.now());
    failure = "capability_unavailable";
    await readRootPinnedBridgeFile(
      RELEASE_BRIDGE_CAPABILITIES,
      pin.capabilitiesSha256,
    );
    const module = await import(
      new URL(`file://${RELEASE_BRIDGE_CAPABILITIES}`).href
    ) as {
      openReleaseBridgeCapabilities?: () => Promise<ReleaseBridgeCapabilities>;
    };
    if (typeof module.openReleaseBridgeCapabilities !== "function") {
      return releaseBridgeFailure("capability_unavailable");
    }
    return await runReleaseBridge(
      input,
      pin,
      await module.openReleaseBridgeCapabilities(),
    );
  } catch {
    return releaseBridgeFailure(failure);
  } finally {
    bytes?.fill(0);
  }
}

if (import.meta.main) {
  const result = await vpsReleaseBridgeMain();
  // Only closed public fields cross stdout; no exception, native token or driver receipt.
  const output = new TextEncoder().encode(`${JSON.stringify(result)}\n`);
  if (output.length > 512) Deno.exit(1);
  await Deno.stdout.write(output);
  if (result.status === "refused") Deno.exit(1);
}
