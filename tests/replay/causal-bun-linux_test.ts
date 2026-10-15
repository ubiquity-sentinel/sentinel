import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  asFixtureDigest,
  asGitSha,
  type WorkItemId,
} from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { GatewayLocalCausalVerifier } from "../../src/replay/causal-verifier.ts";
import type { GatewayCausalVerifierInputV1 } from "../../src/replay/causal-verifier-contracts.ts";
import {
  type BunFrozenReaderBindingV1,
  materializeBunReaderSnapshot,
  prepareBunFrozenReader,
} from "../../src/replay/bun-frozen-reader.ts";
import {
  BUN_READER_BOOTSTRAP_PATH,
  BUN_READER_PREFLIGHT_PATH,
  BUN_READER_PREFLIGHT_STDOUT,
} from "../../src/replay/bun-reader-bootstrap.ts";
import {
  LinuxReplayIsolation,
  type ReplayCheckoutAccessV1,
} from "../../src/replay/isolation.ts";
import {
  computeReplayFixtureDigest,
  markerProofParser,
} from "../../src/replay/fixture.ts";
import { prepareReplayRequest } from "../../src/replay/port-request.ts";
import {
  DenoReplayRuntime,
  type ReplayCommandInputV1,
  type ReplayCommandResultV1,
} from "../../src/replay/runtime.ts";
import { artifactRef } from "../../src/adapters/gateway/incident-adapter.ts";
import {
  makeRig,
  removeRoot,
} from "../adapters/gateway/replay-composition-helpers.ts";
import { causalReplayConfig } from "../adapters/gateway/replay-composition-causal-helpers.ts";
import {
  baseMetadata,
  CAPTURE_ID_V2,
  CAPTURED_AT_V2,
  craftWireCapture,
  hexToBytes,
  INDEX_PATH,
  readGolden,
  standardBase64,
} from "../adapters/gateway/replay-composition-fixtures.ts";
import {
  INCIDENT_A,
  jsonResponse,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
  validConfig,
} from "../adapters/gateway/helpers.ts";
import {
  decode,
  encode,
  makeCapture,
  REQUEST_PATH,
  UPSTREAM_PATH,
  verifierInput,
} from "./causal-verifier-helpers.ts";

/** Test-only parent-owned immutable input; absent ordinary CI cannot claim acceptance. */
const INPUT_PATH =
  "/tmp/ai-bun-deploy-20261015/sentinel/reader-acceptance-input.json";
interface AcceptanceInput {
  sourcePath: string;
  scratchDir: string;
  binding: BunFrozenReaderBindingV1;
  directExecProbe?: { path: string; digest: string };
}
async function acceptanceInput(): Promise<AcceptanceInput | null> {
  if (Deno.build.os !== "linux" || Deno.build.arch !== "aarch64") return null;
  if (
    (await Deno.permissions.query({ name: "read", path: INPUT_PATH })).state !==
      "granted"
  ) return null;
  try {
    return JSON.parse(await Deno.readTextFile(INPUT_PATH)) as AcceptanceInput;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}
const INPUT = await acceptanceInput();
const IDS = ["zeta", "alpha", "middle", "A.b:C_d"];
const MARKERS = IDS.map((id) => `sentinel-replay-test:${id}\n`).join("");
const FAILURE = {
  reason: "stream terminated unexpectedly",
  match: { kind: "contains" as const, text: "stream terminated unexpectedly" },
};
const FAILURE_STDOUT = MARKERS +
  "sentinel-causal-failure:stream terminated unexpectedly\n";
const BODY = JSON.stringify({
  model: "synthetic-model",
  stream: true,
  input: [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "M53_SYNTHETIC_ORIGINAL_TEXT" }],
  }],
});

/** One diagnostic only: original reader bytes, existing report mode, no causal acceptance. */
Deno.test({
  name:
    "causal verifier (Linux Bun ARM64): diagnostic confined read parse and existing reader report",
  ignore: INPUT === null,
  fn: async () => {
    const input = INPUT!;
    const reader = await prepareBunFrozenReader(input.binding);
    await Deno.mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
    const scratch = await Deno.makeTempDir({
      dir: input.scratchDir,
      prefix: "m53-diagnostic-",
    });
    const snapshot = `${scratch}/snapshot`;
    let observed: ReplayCommandResultV1 | undefined;
    try {
      await materializeBunReaderSnapshot(reader, snapshot);
      const binary = `${snapshot}/.m53-diagnostic-bun`;
      await Deno.copyFile(input.binding.runtime.path, binary);
      await Deno.chmod(binary, 0o500);
      assert.equal(
        createHash("sha256").update(await Deno.readFile(binary)).digest("hex"),
        input.binding.runtime.binaryDigest,
      );
      const metadata = {
        version: "v1",
        requestPath: REQUEST_PATH,
        upstreamPath: UPSTREAM_PATH,
        testIds: IDS,
        report: "structured-v1",
      };
      const requestBytes = encode(JSON.stringify({ body: BODY }));
      const upstreamBytes = encode(JSON.stringify(upstream(true)));
      for (const path of [REQUEST_PATH, UPSTREAM_PATH]) {
        await Deno.mkdir(
          `${snapshot}/${path.slice(0, path.lastIndexOf("/"))}`,
          { recursive: true },
        );
      }
      await Deno.writeTextFile(
        `${snapshot}/.sentinel-replay-input.json`,
        JSON.stringify(metadata),
      );
      await Deno.writeFile(`${snapshot}/${REQUEST_PATH}`, requestBytes);
      await Deno.writeFile(`${snapshot}/${UPSTREAM_PATH}`, upstreamBytes);
      const source =
        `import {applyLinuxPermissions} from './src/runtime/permissions-linux.ts';
import {readFileSync,writeSync} from 'node:fs';
import {createHash} from 'node:crypto';
const receipt=applyLinuxPermissions({read:[import.meta.dir,process.execPath,'/dev/urandom','/dev/null'],write:[]});
const emit=(value)=>writeSync(1,new TextEncoder().encode('sentinel-reader-diagnostic:'+JSON.stringify(value)+'\\n'));
let stage='metadata-read';
try {
  const metadata=JSON.parse(readFileSync('.sentinel-replay-input.json','utf8'));
  const inputs=[];
  for(const path of [metadata.requestPath,metadata.upstreamPath]) {stage='input-read';const bytes=readFileSync(path);inputs.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  stage='request-parse';const request=JSON.parse(readFileSync(metadata.requestPath,'utf8'));const body=JSON.parse(request.body);
  if(!body||(!Array.isArray(body.input)&&typeof body.input!=='string'))throw Error('unsupported synthetic body');
  stage='trace-parse';const {parseSentinelUpstreamTrace}=await import('./src/sentinel/upstream-capture.ts');const trace=parseSentinelUpstreamTrace(JSON.parse(readFileSync(metadata.upstreamPath,'utf8')));
  emit({stage:'inputs-parsed',inputs,attempts:trace.attempts.length,landlockAbi:receipt.landlockAbi,filesystemThreadSync:receipt.filesystemThreadSync,processThreadSync:receipt.processThreadSync});
  stage='actual-reader';await import('./scripts/replay.ts');
} catch(error) {emit({stage,outcome:'failed',name:typeof error?.name==='string'?error.name:'unknown',code:typeof error?.code==='string'?error.code:null});process.exit(8);}
`;
      const launcher = `${snapshot}/.m53-diagnostic.ts`;
      await Deno.writeTextFile(launcher, source);
      const concrete = new DenoReplayRuntime("/usr/local/bin:/usr/bin:/bin");
      const isolation = new LinuxReplayIsolation(scratch, {
        runtime: {
          run(command) {
            const args = [...command.args];
            const mounts = [
              "--setenv",
              "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
              "0",
            ];
            for (
              const name of ["node_modules", ".uos-permissions", ".native"]
            ) {
              mounts.push(
                "--ro-bind",
                `${input.binding.artifact.root}/${name}`,
                `${snapshot}/${name}`,
              );
            }
            args.splice(args.indexOf("--chdir"), 0, ...mounts);
            return concrete.run({ ...command, args });
          },
        },
      });
      const command: ReplayCommandInputV1 = {
        executable: binary,
        args: ["--no-env-file", "--no-install", "run", launcher],
        cwd: snapshot,
        env: {},
        maxDurationMs: 10_000,
        maxOutputBytes: 262_144,
      };
      observed = await isolation.run(command, "read-only");
      await Deno.writeTextFile(
        "/tmp/ai-bun-deploy-20261015/sentinel/implementation/reader-stage-diagnostic.json",
        JSON.stringify(
          {
            diagnosticOnly: true,
            sourceSha: input.binding.sourceSha,
            binding: input.binding,
            manifest: reader.manifest,
            inputs: {
              metadata,
              requestSha256: createHash("sha256").update(requestBytes).digest(
                "hex",
              ),
              upstreamSha256: createHash("sha256").update(upstreamBytes).digest(
                "hex",
              ),
            },
            command,
            result: observed,
          },
          (_key, value) => value instanceof Uint8Array ? decode(value) : value,
          2,
        ),
      );
      assert.equal(observed.settled, true);
      assert.equal(observed.truncated, false);
      assert.equal(observed.outcome, "exited", observed.detail);
      console.log(
        JSON.stringify({
          diagnosticOnly: true,
          readerExitCode: observed.exitCode,
          resultPath: "reader-stage-diagnostic.json",
        }),
      );
    } finally {
      if (observed === undefined || observed.settled) {
        await Deno.remove(scratch, { recursive: true });
      }
    }
  },
});

function upstream(
  complete = false,
): ReturnType<typeof makeCapture>["upstream"] {
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp_fixture",
        object: "response",
        status: "in_progress",
      },
    },
    ...(complete
      ? [
        {
          type: "response.output_text.delta",
          response_id: "resp_fixture",
          item_id: "msg_fixture",
          output_index: 0,
          content_index: 0,
          delta: "x",
        },
        {
          type: "response.completed",
          response: {
            id: "resp_fixture",
            object: "response",
            status: "completed",
            output: [{
              id: "msg_fixture",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "x", annotations: [] }],
            }],
          },
        },
      ]
      : [{
        type: "response.in_progress",
        response: {
          id: "resp_fixture",
          object: "response",
          status: "in_progress",
        },
      }]),
  ];
  return {
    version: 2,
    attempts: [{
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      headers: { "content-type": "text/event-stream" },
      headers_truncated: false,
      chunks_base64: events.map((event) =>
        standardBase64(encode(`data: ${JSON.stringify(event)}\n\n`))
      ),
      chunk_times_ms: events.map((_, index) => index),
      started_at_ms: CAPTURED_AT_V2,
      headers_at_ms: CAPTURED_AT_V2,
      ended_at_ms: CAPTURED_AT_V2 + events.length,
      terminal: "eof",
    }],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  };
}

type ObservedRun = {
  input: ReplayCommandInputV1;
  access: ReplayCheckoutAccessV1;
  result: ReplayCommandResultV1;
};
function verifier(scratch: string, runs: ObservedRun[], input = INPUT!) {
  const concrete = new LinuxReplayIsolation(scratch, {
    bunReader: input.binding,
  });
  const isolation = {
    attestation: concrete.attestation,
    async run(command: ReplayCommandInputV1, access: ReplayCheckoutAccessV1) {
      const result = await concrete.run(command, access);
      runs.push({ input: command, access, result });
      return result;
    },
  };
  return {
    isolation,
    create(request: string, upstreamPath: string) {
      return new GatewayLocalCausalVerifier({
        sourcePath: input.sourcePath,
        scratchDir: scratch,
        consumerPath: "scripts/replay.ts",
        consumerRequestPath: request,
        consumerUpstreamPath: upstreamPath,
        denoPath: Deno.execPath(),
        readerBindings: [input.binding],
        isolation,
        maxDurationMs: 10_000,
        maxOutputBytes: 262_144,
      });
    },
  };
}

function assertRun(
  result: ReplayCommandResultV1,
  code: number,
  stdout: string,
) {
  assert.equal(result.outcome, "exited", result.detail);
  assert.equal(result.settled, true);
  assert.equal(result.truncated, false);
  assert.equal(result.exitCode, code, result.detail);
  assert.equal(decode(result.stdout), stdout);
  assert.equal(decode(result.stderr), "");
}

Deno.test({
  name:
    "causal verifier (Linux Bun ARM64): actual frozen original/composed reader and ReplayPort proof consumption",
  ignore: INPUT === null,
  fn: async (t) => {
    const input = INPUT!;
    await Deno.mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
    const before = await prepareBunFrozenReader(input.binding);
    const scratch = await Deno.makeTempDir({
      dir: input.scratchDir,
      prefix: "m53-real-reader-",
    });
    const runs: ObservedRun[] = [];
    const real = verifier(scratch, runs);
    try {
      const baselinePassed = await t.step(
        "real semantic-terminal baseline exits zero and aborts before a sanitized run",
        async () => {
          const entries = [
            {
              path: REQUEST_PATH,
              bytes: encode(JSON.stringify({ body: BODY })),
            },
            {
              path: UPSTREAM_PATH,
              bytes: encode(JSON.stringify(upstream(true))),
            },
          ];
          const baseline = await verifierInput({
            capture: {
              ...makeCapture(BODY),
              gitSha: asGitSha(input.binding.sourceSha),
              upstream: upstream(true),
            },
            fixtureEntries: entries,
            bundleDigest: await computeReplayFixtureDigest(entries),
            testIds: IDS,
            expectedFailure: FAILURE,
          });
          assert.equal(
            await real.create(REQUEST_PATH, UPSTREAM_PATH).verify(baseline),
            null,
          );
          assert.equal(runs.length, 2);
          assertRun(runs[0]!.result, 0, BUN_READER_PREFLIGHT_STDOUT);
          assertRun(runs[1]!.result, 0, MARKERS);
          assert.deepEqual(Array.from(Deno.readDirSync(scratch)), []);
        },
      );
      if (!baselinePassed) return;
      const crafted = await craftWireCapture(
        hexToBytes(readGolden().syntheticKeyHex),
        baseMetadata({
          git_sha: input.binding.sourceSha,
          upstream: upstream(),
        }),
        encode(BODY),
      );
      const responder = (url: URL) =>
        url.pathname === INDEX_PATH
          ? jsonResponse(
            makeIndexPage([
              makeIndexRow({
                incident_id: INCIDENT_A,
                fingerprint: crafted.classificationDigest,
                failing_revision: input.binding.sourceSha,
                provenance: {
                  endpoint: "https://ai.ubq.fi",
                  captured_at_ms: CAPTURED_AT_V2,
                  captured_by: "gateway",
                },
                evidence_ref: {
                  ref: artifactRef(INCIDENT_A, CAPTURE_ID_V2),
                  digest: crafted.digest,
                },
                evidence_expires_at_ms: crafted.manifest
                  .expires_at_ms as number,
              }),
            ]),
          )
          : jsonResponse(
            makeReplayPage({
              manifest: crafted.manifest,
              chunks: crafted.chunks,
            }),
          );
      const storeRoot = `${scratch}/store`;
      const rig = await makeRig(responder, {
        storeRoot,
        composition: {
          testIds: IDS,
          testCommandId: "test",
          expectedFailure: FAILURE,
          verifier: {
            verify: (value: GatewayCausalVerifierInputV1) => {
              const root =
                `tests/fixtures/gateway-replay/${value.incidentId}/${value.captureId}`;
              return real.create(
                `${root}/request.json`,
                `${root}/upstream.json`,
              ).verify(value);
            },
          },
        },
      });
      try {
        const incident = await rig.composition.readIncident(INCIDENT_A);
        assert.ok(
          incident.ok && incident.value?.replay,
          JSON.stringify(incident),
        );
        if (!incident.ok || !incident.value?.replay) return;
        const replay = incident.value.replay;
        const resolved = await rig.composition.resolveFixture(
          replay.fixtureRef,
        );
        assert.ok(resolved.ok, JSON.stringify(resolved));
        if (!resolved.ok) return;
        const proof = resolved.value.causalProof;
        assert.ok(proof, "real causal pair produced no proof");
        assert.equal(proof.originalGitSha, input.binding.sourceSha);
        assert.equal(proof.bundleDigest, replay.fixtureDigest);
        assert.equal(resolved.value.provenance.redacted, true);
        assert.ok(
          !JSON.stringify(resolved.value).includes(
            "M53_SYNTHETIC_ORIGINAL_TEXT",
          ),
        );
        for (
          const observed of [
            proof.originalObservation,
            proof.sanitizedObservation,
          ]
        ) {
          assert.deepEqual(observed.observedTestIds, IDS);
          assert.equal(observed.exitCode, 1);
          assert.equal(
            observed.outputDigest,
            createHash("sha256").update(FAILURE_STDOUT).digest("hex"),
          );
        }
        const pair = runs.slice(-3);
        assertRun(pair[0]!.result, 0, BUN_READER_PREFLIGHT_STDOUT);
        assertRun(pair[1]!.result, 1, FAILURE_STDOUT);
        assertRun(pair[2]!.result, 1, FAILURE_STDOUT);
        assert.notEqual(pair[1]!.input.cwd, pair[2]!.input.cwd);
        assert.equal(pair[1]!.access, "read-only");
        assert.equal(pair[2]!.access, "read-only");
        await t.step(
          "actual production ReplayPort request consumer accepts only the bound observed proof",
          async () => {
            const config = {
              ...causalReplayConfig(),
              repository: validConfig().repository,
            };
            const options = {
              config,
              source: { kind: "local" as const, path: input.sourcePath },
              scratchDir: scratch,
              fixtures: {
                resolveFixture: () => Promise.resolve(portOk(resolved.value)),
              },
              policy: {
                bundleScopes: ["tests/"],
                maxFixtureBytes: 512 * 1024,
                maxEntryBytes: 256 * 1024,
                proof: markerProofParser(),
              },
              isolation: real.isolation,
            };
            const request = {
              taskId: "incident:m53-frozen-reader" as WorkItemId,
              repository: config.repository,
              revision: asGitSha(input.binding.sourceSha),
              commandId: config.commands.replay,
              fixtureRef: replay.fixtureRef,
              fixtureDigest: replay.fixtureDigest!,
              testIds: IDS,
              outputLimitBytes: 262_144,
            };
            const accepted = await prepareReplayRequest(options, request);
            assert.ok(accepted.ok, JSON.stringify(accepted));
            if (accepted.ok) assert.equal(accepted.value.proofValid, true);
            for (
              const causalProof of [undefined, {
                ...proof,
                bundleDigest: asFixtureDigest("f".repeat(64)),
              }]
            ) {
              const refused = await prepareReplayRequest({
                ...options,
                fixtures: {
                  resolveFixture: () =>
                    Promise.resolve(portOk({ ...resolved.value, causalProof })),
                },
              }, request);
              assert.ok(refused.ok);
              if (refused.ok) assert.equal(refused.value.proofValid, false);
            }
            await Deno.writeTextFile(
              "/tmp/ai-bun-deploy-20261015/sentinel/implementation/real-reader-results.json",
              JSON.stringify(
                {
                  sourceSha: input.binding.sourceSha,
                  binding: input.binding,
                  proof,
                  immutableBefore: before.manifest,
                  immutableAfter:
                    (await prepareBunFrozenReader(input.binding)).manifest,
                  bootstrapDigest: before.bootstrapDigest,
                  preflightDigest: before.preflightDigest,
                  composedBundleDigest: replay.fixtureDigest,
                  productionRequestConsumer: {
                    accepted: true,
                    absentProof: false,
                    changedProof: false,
                    candidateExecuted: false,
                  },
                  runs,
                },
                (_key, value) =>
                  value instanceof Uint8Array ? decode(value) : value,
                2,
              ),
            );
          },
        );
      } finally {
        await removeRoot(storeRoot);
      }
      await t.step(
        "legacy Deno attempt records actual failure and excludes setup errors from RED",
        async () => {
          const legacy = new LinuxReplayIsolation(scratch);
          const observed: ObservedRun[] = [];
          const isolation = {
            attestation: legacy.attestation,
            async run(
              command: ReplayCommandInputV1,
              access: ReplayCheckoutAccessV1,
            ) {
              const result = await legacy.run(command, access);
              observed.push({ input: command, access, result });
              return result;
            },
          };
          const entries = [{
            path: REQUEST_PATH,
            bytes: encode(JSON.stringify({ body: BODY })),
          }, {
            path: UPSTREAM_PATH,
            bytes: encode(JSON.stringify(upstream())),
          }];
          const capture = await verifierInput({
            capture: {
              ...makeCapture(BODY),
              gitSha: asGitSha(input.binding.sourceSha),
              upstream: upstream(),
            },
            fixtureEntries: entries,
            bundleDigest: await computeReplayFixtureDigest(entries),
            testIds: IDS,
            expectedFailure: FAILURE,
          });
          const old = new GatewayLocalCausalVerifier({
            sourcePath: input.sourcePath,
            scratchDir: scratch,
            consumerPath: "scripts/replay.ts",
            consumerRequestPath: REQUEST_PATH,
            consumerUpstreamPath: UPSTREAM_PATH,
            denoPath: Deno.execPath(),
            isolation,
            maxDurationMs: 10_000,
            maxOutputBytes: 262_144,
          });
          assert.equal(await old.verify(capture), null);
          if (observed.length === 0) {
            const report = {
              status: "setup_not_executed",
              legacyReaderRuntimeRedProven: false,
              setupFailureDoesNotCount: true,
              observed,
            };
            console.log(JSON.stringify(report));
            await Deno.mkdir(
              "/tmp/ai-bun-deploy-20261015/sentinel/implementation",
              { recursive: true },
            );
            await Deno.writeTextFile(
              "/tmp/ai-bun-deploy-20261015/sentinel/implementation/legacy-red.json",
              JSON.stringify(report, null, 2),
            );
            return;
          }
          assert.equal(
            observed.length,
            1,
            "legacy original must actually execute before refusing",
          );
          const red = observed[0]!;
          assert.equal(red.result.outcome, "exited", red.result.detail);
          assert.equal(red.result.settled, true);
          assert.equal(red.result.truncated, false);
          assert.notEqual(red.result.exitCode, 0);
          const explicitRuntimeIncompatibility =
            /ReferenceError:\s*Bun is not defined|requires (?:the )?Bun runtime|Bun runtime is required/i
              .test(decode(red.result.stderr));
          console.log(
            JSON.stringify({
              legacyReaderRuntimeRedProven: explicitRuntimeIncompatibility,
              setupFailureDoesNotCount: true,
            }),
          );
          await Deno.mkdir(
            "/tmp/ai-bun-deploy-20261015/sentinel/implementation",
            { recursive: true },
          );
          await Deno.writeTextFile(
            "/tmp/ai-bun-deploy-20261015/sentinel/implementation/legacy-red.json",
            JSON.stringify(
              {
                ...red,
                explicitRuntimeIncompatibility,
                setupFailureDoesNotCount: true,
              },
              (_key, value) =>
                value instanceof Uint8Array ? decode(value) : value,
              2,
            ),
          );
        },
      );
      assert.deepEqual(Array.from(Deno.readDirSync(scratch)), []);
      await prepareBunFrozenReader(input.binding);
    } finally {
      await Deno.mkdir(
        "/tmp/ai-bun-deploy-20261015/sentinel/implementation",
        { recursive: true },
      );
      await Deno.writeTextFile(
        "/tmp/ai-bun-deploy-20261015/sentinel/implementation/observed-reader-runs.json",
        JSON.stringify(
          { sourceSha: input.binding.sourceSha, runs },
          (_key, value) => value instanceof Uint8Array ? decode(value) : value,
          2,
        ),
      );
      if (runs.every((run) => run.result.settled)) {
        await Deno.remove(scratch, { recursive: true });
      }
    }
  },
});

Deno.test({
  name:
    "causal verifier (Linux Bun ARM64): source and artifact pins refuse before private files",
  ignore: INPUT === null,
  fn: async () => {
    const input = INPUT!;
    await Deno.mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
    const cases: BunFrozenReaderBindingV1[] = [
      { ...input.binding, sourceSha: "f".repeat(40) },
      {
        ...input.binding,
        artifact: { ...input.binding.artifact, digest: "f".repeat(64) },
      },
      {
        ...input.binding,
        artifact: { ...input.binding.artifact, manifestDigest: "f".repeat(64) },
      },
      {
        ...input.binding,
        runtime: { ...input.binding.runtime, binaryDigest: "f".repeat(64) },
      },
      {
        ...input.binding,
        runtime: { ...input.binding.runtime, archiveDigest: "f".repeat(64) },
      },
    ];
    for (const [index, binding] of cases.entries()) {
      const scratch = `${input.scratchDir}/m53-refused-${crypto.randomUUID()}`;
      const runs: ObservedRun[] = [];
      const real = verifier(input.scratchDir, runs, { ...input, binding });
      const causal = new GatewayLocalCausalVerifier({
        sourcePath: input.sourcePath,
        scratchDir: scratch,
        consumerPath: "scripts/replay.ts",
        consumerRequestPath: REQUEST_PATH,
        consumerUpstreamPath: UPSTREAM_PATH,
        denoPath: Deno.execPath(),
        readerBindings: [binding],
        isolation: real.isolation,
        maxDurationMs: 10_000,
        maxOutputBytes: 262_144,
      });
      assert.equal(
        await causal.verify(
          await verifierInput({
            capture: {
              ...makeCapture(),
              gitSha: asGitSha(input.binding.sourceSha),
            },
          }),
        ),
        null,
        `pin case ${index}`,
      );
      assert.equal(runs.length, 0);
      await assert.rejects(() => Deno.lstat(scratch), Deno.errors.NotFound);
    }
    const reader = await prepareBunFrozenReader(input.binding);
    for (const mutation of ["helper", "ancestor", "bootstrap", "bunfig"]) {
      const scratch = await Deno.makeTempDir({
        dir: input.scratchDir,
        prefix: "m53-snapshot-tamper-",
      });
      const snapshot = `${scratch}/snapshot`;
      let starts = 0;
      try {
        await materializeBunReaderSnapshot(reader, snapshot);
        if (mutation === "ancestor") {
          await Deno.rename(
            `${snapshot}/src/runtime`,
            `${snapshot}/src/runtime-moved`,
          );
          const link = await new DenoReplayRuntime(
            "/usr/local/bin:/usr/bin:/bin",
          ).run({
            executable: "/usr/bin/ln",
            args: ["-s", "runtime-moved", `${snapshot}/src/runtime`],
            cwd: snapshot,
            env: {},
            maxDurationMs: 10_000,
            maxOutputBytes: 4096,
          });
          assertRun(link, 0, "");
        } else {
          const path = mutation === "helper"
            ? "src/runtime/permissions-linux.ts"
            : mutation === "bootstrap"
            ? BUN_READER_PREFLIGHT_PATH
            : "bunfig.toml";
          await Deno.chmod(`${snapshot}/${path}`, 0o600);
          await Deno.writeTextFile(
            `${snapshot}/${path}`,
            "throw new Error('M53 tampered before enforcement');\n",
          );
        }
        const isolation = new LinuxReplayIsolation(scratch, {
          bunReader: input.binding,
          runtime: {
            run() {
              starts++;
              throw new Error("tampered snapshot must not execute");
            },
          },
        });
        const result = await isolation.run({
          executable: input.binding.runtime.path,
          args: [
            "--no-env-file",
            "--no-install",
            "run",
            `${snapshot}/${BUN_READER_PREFLIGHT_PATH}`,
          ],
          cwd: snapshot,
          env: {},
          maxDurationMs: 10_000,
          maxOutputBytes: 4096,
        }, "read-only");
        assert.equal(result.outcome, "spawn_failed", mutation);
        assert.equal(starts, 0, mutation);
      } finally {
        await Deno.remove(scratch, { recursive: true });
      }
    }
  },
});

/** Auxiliary hostile consumers share the real fixed bootstrap, never the causal proof. */
Deno.test({
  name:
    "causal verifier (Linux Bun ARM64): real read write process and raw exec syscall controls",
  ignore: INPUT === null,
  fn: async () => {
    const input = INPUT!;
    await Deno.mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
    const reader = await prepareBunFrozenReader(input.binding);
    const scratch = await Deno.makeTempDir({
      dir: input.scratchDir,
      prefix: "m53-os-controls-",
    });
    const runtime = new DenoReplayRuntime("/usr/local/bin:/usr/bin:/bin");
    const isolation = new LinuxReplayIsolation(scratch, {
      runtime: {
        run(command) {
          const args = [...command.args];
          args.splice(
            args.indexOf("--chdir"),
            0,
            "--setenv",
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
            "0",
          );
          return runtime.run({ ...command, args });
        },
      },
    });
    const emptyHome = `${scratch}/empty-home`;
    await Deno.mkdir(emptyHome);
    const baseline = async (source: string) =>
      await runtime.run({
        executable: input.binding.runtime.path,
        args: ["--no-env-file", "--no-install", "-e", source],
        cwd: scratch,
        env: {
          HOME: emptyHome,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          NO_COLOR: "1",
        },
        maxDurationMs: 10_000,
        maxOutputBytes: 262_144,
      });
    const run = async (
      source: string,
      files: Record<string, Uint8Array> = {},
      threadLauncher = false,
    ) => {
      const snapshot = `${scratch}/case-${crypto.randomUUID()}`;
      await materializeBunReaderSnapshot(reader, snapshot);
      // Auxiliary hostile source uses a separate real namespace child; production
      // frozen-reader isolation rejects modified source before any execution.
      await Deno.copyFile(
        input.binding.runtime.path,
        `${snapshot}/m53-pinned-bun`,
      );
      await Deno.chmod(`${snapshot}/m53-pinned-bun`, 0o500);
      for (const name of ["manifest.json", "linux-arm64.node"]) {
        await Deno.copyFile(
          `${input.binding.artifact.root}/.uos-permissions/${name}`,
          `${snapshot}/.uos-permissions/${name}`,
        );
      }
      // Only this auxiliary test-controlled consumer changes; accepted real-source pair above stays exact.
      const sourcePath = threadLauncher
        ? "m53-thread-control.ts"
        : "scripts/replay.ts";
      await Deno.writeTextFile(`${snapshot}/${sourcePath}`, source);
      for (const [path, bytes] of Object.entries(files)) {
        await Deno.writeFile(`${snapshot}/${path}`, bytes);
      }
      const result = await isolation.run({
        executable: `${snapshot}/m53-pinned-bun`,
        args: [
          "--no-env-file",
          "--no-install",
          "run",
          `${snapshot}/${
            threadLauncher ? sourcePath : BUN_READER_BOOTSTRAP_PATH
          }`,
        ],
        cwd: snapshot,
        env: {},
        maxDurationMs: 10_000,
        maxOutputBytes: 262_144,
      }, "read-only");
      assert.equal(result.settled, true);
      await Deno.remove(snapshot, { recursive: true });
      return result;
    };
    try {
      const outside = `${scratch}/outside-canary`;
      await Deno.writeTextFile(outside, "PUBLIC_M53_CANARY");
      assertRun(
        await baseline(
          `process.stdout.write(require('node:fs').readFileSync(${
            JSON.stringify(outside)
          },'utf8'))`,
        ),
        0,
        "PUBLIC_M53_CANARY",
      );
      // /usr is actually mounted and the library file exists; EPERM/EACCES establishes Landlock, not ENOENT.
      const systemCanary = "/usr/bin/env";
      assert.equal((await Deno.stat(systemCanary)).isFile, true);
      const denial = (operation: string, name: string) =>
        `try { ${operation}; process.stdout.write('ESCAPED\\n'); process.exit(9); } catch(e) { if(!['EACCES','EPERM','EROFS'].includes(e.code)) throw e; process.stdout.write(${
          JSON.stringify(`denied:${name}\n`)
        }); }`;
      assertRun(
        await run(
          `import {readFileSync} from 'node:fs'; ${
            denial(
              `readFileSync(${JSON.stringify(systemCanary)})`,
              "outside-read",
            )
          }`,
        ),
        0,
        "denied:outside-read\n",
      );
      assertRun(
        await run(
          `import {writeFileSync} from 'node:fs'; ${
            denial("writeFileSync('/tmp/m53-private-write','x')", "tmp-write")
          }`,
        ),
        0,
        "denied:tmp-write\n",
      );
      assertRun(
        await run(
          `import {writeFileSync} from 'node:fs'; ${
            denial("writeFileSync('scripts/replay.ts','x')", "source-write")
          }`,
        ),
        0,
        "denied:source-write\n",
      );
      const tmpCanary =
        `${input.scratchDir}/m53-baseline-${crypto.randomUUID()}`;
      assertRun(
        await baseline(
          `require('node:fs').writeFileSync(${
            JSON.stringify(tmpCanary)
          },'x'); process.stdout.write('write-baseline\\n');`,
        ),
        0,
        "write-baseline\n",
      );
      await Deno.remove(tmpCanary);
      const spawnCode =
        `for(const binary of ['/bin/sh',process.execPath]) { try { const result=Bun.spawnSync([binary,...(binary==='/bin/sh'?['-c','echo ESCAPED']:['--no-env-file','--no-install','-e',"console.log('ESCAPED')"])]); if(!result.error || !['EACCES','EPERM'].includes(result.error.code)) { process.stdout.write('ESCAPED\\n'); process.exit(9); } } catch(e) { if(!['EACCES','EPERM'].includes(e.code)) throw e; } } process.stdout.write('denied:spawn\\n');`;
      assertRun(
        await baseline(
          `const r=Bun.spawnSync([process.execPath,'--no-env-file','--no-install','-e',"process.stdout.write('BASELINE')"]); process.stdout.write(r.stdout); process.exit(r.exitCode);`,
        ),
        0,
        "BASELINE",
      );
      assertRun(await run(spawnCode), 0, "denied:spawn\n");
      const asyncSpawn =
        `for(const binary of ['/bin/sh',process.execPath]) { try { const child=Bun.spawn([binary,...(binary==='/bin/sh'?['-c','echo ESCAPED']:['--no-env-file','--no-install','-e',"console.log('ESCAPED')"])]); await child.exited; process.exit(9); } catch(e) { if(!['EACCES','EPERM'].includes(e.code)) throw e; } } process.stdout.write('denied:async-spawn\\n');`;
      assertRun(await run(asyncSpawn), 0, "denied:async-spawn\n");
      const nodeSpawn =
        `import {spawnSync,execFileSync} from 'node:child_process'; for(const binary of ['/bin/sh',process.execPath]) { const args=binary==='/bin/sh'?['-c','echo ESCAPED']:['--no-env-file','--no-install','-e',"console.log('ESCAPED')"]; const result=spawnSync(binary,args); if(!result.error || !['EACCES','EPERM'].includes(result.error.code)) process.exit(9); try {execFileSync(binary,args);process.exit(9);} catch(e) {if(!['EACCES','EPERM'].includes(e.code)) throw e;} } process.stdout.write('denied:node-spawn\\n');`;
      assertRun(await run(nodeSpawn), 0, "denied:node-spawn\n");
      const networkAbort = new AbortController();
      const server = Deno.serve({
        hostname: "127.0.0.1",
        port: 43179,
        signal: networkAbort.signal,
        onListen() {},
      }, () => new Response("PUBLIC_M53_NETWORK"));
      try {
        assertRun(
          await baseline(
            "process.stdout.write(await (await fetch('http://127.0.0.1:43179')).text())",
          ),
          0,
          "PUBLIC_M53_NETWORK",
        );
        assertRun(
          await run(
            "try {await fetch('http://127.0.0.1:43179',{signal:AbortSignal.timeout(1000)});process.exit(9);} catch {process.stdout.write('denied:host-network\\n');}",
          ),
          0,
          "denied:host-network\n",
        );
      } finally {
        networkAbort.abort();
        await server.finished;
      }
      assert.ok(
        input.directExecProbe,
        "full acceptance requires the separately hosted compiled raw-exec probe",
      );
      const probe = await Deno.readFile(input.directExecProbe.path);
      assert.equal(
        createHash("sha256").update(probe).digest("hex"),
        input.directExecProbe.digest,
      );
      for (const kind of [1, 2]) {
        const load = `const m={exports:{}}; process.dlopen(m,PROBE);`;
        assertRun(
          await baseline(
            `${
              load.replace("PROBE", JSON.stringify(input.directExecProbe.path))
            } m.exports.execAttempt(${kind},process.execPath); throw Error('direct exec baseline failed');`,
          ),
          0,
          "SENTINEL_DIRECT_EXEC_REPLACED\n",
        );
        const code = `${
          load.replace("PROBE", "process.cwd()+'/m53-exec-probe.node'")
        } const r=m.exports.execAttempt(${kind},process.execPath); if(r.stage!=='syscall'||r.returnValue!==-1||r.errno!==1) throw Error('raw exec was not denied'); process.stdout.write('denied:exec${kind}\\n');`;
        assertRun(
          await run(code, { "m53-exec-probe.node": probe }),
          0,
          `denied:exec${kind}\n`,
        );
      }
      const workerSource = `import {readFileSync} from 'node:fs';
postMessage('ready');
onmessage = ({data}) => {
  if(data==='baseline') { readFileSync('/usr/bin/env'); postMessage('baseline'); return; }
  try {readFileSync('/usr/bin/env'); throw Error('read escaped');} catch(e) {if(!['EACCES','EPERM'].includes(e.code)) throw e;}
  try {const child=Bun.spawnSync([process.execPath,'--no-env-file','--no-install','-e',"console.log('ESCAPED')"]); if(!child.error||!['EACCES','EPERM'].includes(child.error.code)) throw Error('spawn escaped');} catch(e) {if(!['EACCES','EPERM'].includes(e.code)) throw e;}
  postMessage('denied');
};`;
      const threadSource =
        `import {applyLinuxPermissions} from './src/runtime/permissions-linux.ts';
const next=(worker)=>new Promise((resolve,reject)=>{worker.onmessage=({data})=>resolve(data);worker.onerror=reject;});
const existing=new Worker(new URL('./m53-worker.ts',import.meta.url).href); if(await next(existing)!=='ready') throw Error('no old worker');
let pending=next(existing);existing.postMessage('baseline');if(await pending!=='baseline')throw Error('no worker read baseline');
const receipt=applyLinuxPermissions({read:[process.cwd(),process.execPath,'/dev/urandom','/dev/null'],write:[]});
pending=next(existing);existing.postMessage('probe');if(await pending!=='denied')throw Error('old worker escaped');
const fresh=new Worker(new URL('./m53-worker.ts',import.meta.url).href);if(await next(fresh)!=='ready')throw Error('no new worker');
pending=next(fresh);fresh.postMessage('probe');if(await pending!=='denied')throw Error('new worker escaped');
existing.terminate();fresh.terminate();process.stdout.write(JSON.stringify(receipt)+'\\n');`;
      const threads = await run(threadSource, {
        "m53-worker.ts": encode(workerSource),
      }, true);
      assert.equal(threads.outcome, "exited", threads.detail);
      assert.equal(threads.exitCode, 0, decode(threads.stderr));
      assert.equal(threads.truncated, false);
      assert.equal(decode(threads.stderr), "");
      const receipt = JSON.parse(decode(threads.stdout));
      assert.ok(receipt.landlockAbi >= 8);
      assert.equal(receipt.filesystemThreadSync, true);
      assert.equal(receipt.processThreadSync, true);
      await Deno.writeTextFile(
        "/tmp/ai-bun-deploy-20261015/sentinel/implementation/native-control-receipt.json",
        JSON.stringify(receipt, null, 2),
      );
      await prepareBunFrozenReader(input.binding);
    } finally {
      await Deno.remove(scratch, { recursive: true });
    }
  },
});
