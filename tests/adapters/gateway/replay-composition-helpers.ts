import type { GatewayAuthProviderV1 } from "../../../src/adapters/gateway/http.ts";
import { LocalArtifactStore } from "../../../src/adapters/gateway/store.ts";
import {
  FakeClock,
  INCIDENT_A,
  jsonResponse,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
  recordingTransport,
  sha256hex,
  validConfig,
} from "./helpers.ts";
import { GatewayReplayComposition } from "../../../src/adapters/gateway/replay-composition.ts";
import {
  CAPTURE_ID_V2,
  CAPTURED_AT_V2,
  COMMAND_ID,
  craftWireCapture,
  EXPECTED_FAILURE,
  GIT_SHA,
  hexToBytes,
  INDEX_PATH,
  LIMITS,
  PRIVATE_MARKERS,
  readGolden,
  SANITIZER_POLICY,
  TEST_IDS,
  v2Body,
} from "./replay-composition-fixtures.ts";
import assert from "node:assert/strict";
import {
  artifactRef,
  GatewayIncidentAdapter,
} from "../../../src/adapters/gateway/incident-adapter.ts";
import { decodeBase64Url } from "../../../src/adapters/gateway/wire.ts";
import type { ResolvedFixtureV1 } from "../../../src/replay/fixture.ts";
import type { RepositoryConfigV1 } from "../../../src/contracts/repository-config.ts";
import { parseRepositoryConfigV1 } from "../../../src/contracts/repository-config.ts";
import { TOY_REPOSITORY } from "../../replay/helpers.ts";

// ---------------------------------------------------------------------------
// Rig builders
// ---------------------------------------------------------------------------

export function authProvider(): GatewayAuthProviderV1 {
  return {
    headers: () =>
      Promise.resolve({
        ok: true as const,
        value: { Authorization: "Bearer synthetic-token" },
      }),
  };
}

interface CompositionRigV1 {
  store: LocalArtifactStore;
  clock: FakeClock;
  root: string;
  transport: ReturnType<typeof recordingTransport>;
  composition: GatewayReplayComposition;
  keyBytes: Uint8Array<ArrayBuffer>;
}

export async function makeRig(
  responder: (url: URL) => Response | Promise<Response>,
  overrides: {
    clockStart?: number;
    storeRoot?: string;
    repository?: { owner: string; name: string; installationId: number };
    keyBytes?: Uint8Array<ArrayBuffer>;
    /** Optional extra constructor options (trusted verifier capability). */
    composition?: Record<string, unknown>;
  } = {},
): Promise<CompositionRigV1> {
  const root = overrides.storeRoot ??
    await Deno.makeTempDir({
      dir: Deno.cwd(),
      prefix: "sentinel-wave-c-composition-",
    });
  const store = new LocalArtifactStore({ root, limits: LIMITS });
  const opened = await store.open();
  assert.ok(opened.ok, `store open failed: ${JSON.stringify(opened)}`);
  const transport = recordingTransport(responder);
  const clock = new FakeClock(overrides.clockStart ?? CAPTURED_AT_V2);
  const config = validConfig();
  const adapter = new GatewayIncidentAdapter({
    config,
    transport,
    auth: authProvider(),
    clock,
    store,
  });
  const keyBytes = overrides.keyBytes ??
    hexToBytes(readGolden().syntheticKeyHex);
  const composition = new GatewayReplayComposition({
    adapter,
    store,
    repository: overrides.repository ?? config.repository,
    keyBytes,
    policy: SANITIZER_POLICY,
    commandId: COMMAND_ID,
    testIds: TEST_IDS,
    expectedFailure: EXPECTED_FAILURE,
    clock,
    ...overrides.composition,
  });
  return {
    store,
    clock,
    root,
    transport,
    composition,
    keyBytes,
  };
}

/** Exact concatenated golden ciphertext (public fixture bytes). */
export function goldenCiphertext(): Uint8Array<ArrayBuffer> {
  const golden = readGolden();
  const chunks = golden.exported.chunks.map((encoded) => {
    const decoded = decodeBase64Url(encoded);
    assert.notEqual(decoded, null);
    return decoded!;
  });
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Exact index row bound to the golden capture (public synthetic identities). */
function goldenRow(digest: string): Record<string, unknown> {
  const manifest = readGolden().exported.manifest as {
    fingerprint: string;
    expires_at_ms: number;
  };
  return makeIndexRow({
    incident_id: INCIDENT_A,
    fingerprint: manifest.fingerprint,
    failing_revision: GIT_SHA,
    provenance: {
      endpoint: "https://ai.ubq.fi",
      captured_at_ms: CAPTURED_AT_V2,
      captured_by: "gateway",
    },
    evidence_ref: {
      ref: artifactRef(INCIDENT_A, CAPTURE_ID_V2),
      digest,
    },
    evidence_expires_at_ms: manifest.expires_at_ms,
  });
}

/** Golden-v2 responder: the actual recorded producer capture. */
export async function goldenResponder(
  rowOverride: Record<string, unknown> = {},
): Promise<(url: URL) => Response> {
  const golden = readGolden();
  const digest = await sha256hex(await goldenCiphertext());
  return (url: URL) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(
        makeIndexPage([{ ...goldenRow(digest), ...rowOverride }]),
      );
    }
    return jsonResponse(makeReplayPage({
      manifest: golden.exported.manifest,
      chunks: golden.exported.chunks,
    }));
  };
}

export async function removeRoot(root: string): Promise<void> {
  await Deno.remove(root, { recursive: true }).catch(() => {});
}

/** Serialize a fixture request/upstream entry to a JSON value for asserts. */
export function parseEntry(
  resolved: ResolvedFixtureV1,
  name: "request" | "upstream",
): Record<string, unknown> {
  const entry = resolved.entries.find((item) =>
    item.path.endsWith(`/${name}.json`)
  );
  assert.notEqual(entry, undefined, `expected ${name}.json entry`);
  return JSON.parse(new TextDecoder().decode(entry!.bytes)) as Record<
    string,
    unknown
  >;
}

export async function countStoreBinFiles(root: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(`${root}/entries`)) {
    if (entry.name.endsWith(".bin")) count += 1;
  }
  return count;
}

export async function walkFiles(
  dir: string,
  out: string[] = [],
): Promise<string[]> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) await walkFiles(path, out);
    else out.push(path);
  }
  return out;
}

export function assertNoPrivateMarkers(value: unknown): void {
  const text = JSON.stringify(value);
  for (const marker of PRIVATE_MARKERS) {
    assert.ok(
      !text.includes(marker as string),
      `private marker leaked: ${marker}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Positive: actual ReplayPort resolves the composition fixture and executes
// the configured credential-free command; fresh instance rehydration.
// ---------------------------------------------------------------------------

export const FIXTURE_REPLAY_SCRIPT =
  `const incident = "provider-00000000-0000-4000-8000-000000000001";
const capture = "synthetic-capture-2";
const base = "tests/fixtures/gateway-replay/" + incident + "/" + capture;
const request = JSON.parse(await Deno.readTextFile(base + "/request.json"));
const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json"));
console.log("sentinel-replay-test:gateway:complete-upstream");
const body = JSON.parse(request.body);
if (body.model !== "synthetic-model") Deno.exit(1);
if (!upstream.attempts.every((a: { terminal: string }) => a.terminal === "eof")) {
  Deno.exit(1);
}
`;

export function replayConfig(): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: TOY_REPOSITORY,
    baseBranch: "main",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: {
        replay: {
          executable: "deno",
          args: ["task", "replay"],
          maxDurationMs: 30000,
          maxOutputBytes: 262144,
        },
        test: {
          executable: "deno",
          args: ["eval", "true"],
          maxDurationMs: 30000,
          maxOutputBytes: 262144,
        },
      },
    },
    protectedPaths: ["src/"],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: null,
    sessionBound: null,
    retention: null,
    stabilityPolicy: null,
  });
}

// ---------------------------------------------------------------------------
// Negative: no upstream / partial / non-eof traces keep replay null
// ---------------------------------------------------------------------------

export async function readCrafted(
  metadata: Record<string, unknown>,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<{
  read: Promise<Awaited<ReturnType<GatewayReplayComposition["readIncident"]>>>;
  cleanup: () => Promise<void>;
}> {
  const crafted = await craftWireCapture(keyBytes, metadata, v2Body());
  const responder = (url: URL): Response => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([
        makeIndexRow({
          incident_id: INCIDENT_A,
          fingerprint: crafted.manifest.fingerprint as string,
          failing_revision: GIT_SHA,
          provenance: {
            endpoint: "https://ai.ubq.fi",
            captured_at_ms: CAPTURED_AT_V2,
            captured_by: "gateway",
          },
          evidence_ref: {
            ref: artifactRef(INCIDENT_A, CAPTURE_ID_V2),
            digest: crafted.digest,
          },
          evidence_expires_at_ms: crafted.manifest.expires_at_ms as number,
        }),
      ]));
    }
    return jsonResponse(makeReplayPage({
      manifest: crafted.manifest,
      chunks: crafted.chunks,
    }));
  };
  const { composition, root } = await makeRig(responder, { keyBytes });
  return {
    read: composition.readIncident(INCIDENT_A),
    cleanup: () => removeRoot(root),
  };
}
