import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { RetainedGatewayCaptureV1 } from "../adapters/gateway/decrypt.ts";
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
} from "./causal-proof.ts";
import type { GatewayCausalProofV1 } from "./causal-proof.ts";
import { computeReplayFixtureDigest } from "./fixture.ts";
import type { ReplayFixtureEntryV1 } from "./fixture.ts";
import type {
  GatewayCausalVerifierInputV1,
  GatewayCausalVerifierV1,
  GatewayLocalCausalVerifierOptionsV1,
} from "./causal-verifier-contracts.ts";
import { CausalVerifierExecution } from "./causal-verifier-execution.ts";
import type { PreparedCausalReaderV1 } from "./causal-verifier-execution.ts";
import {
  materializeBunReaderSnapshot,
  prepareBunFrozenReader,
} from "./bun-frozen-reader.ts";
import { BUN_READER_PREFLIGHT_STDOUT } from "./bun-reader-bootstrap.ts";
import {
  buildSentinelReplayInputMetadata,
  SENTINEL_REPLAY_INPUT_PATH,
} from "./causal-dispatch.ts";
import {
  classifyObservation,
  copyExpectedFailure,
  decodeFatal,
  encode,
  entryBytes,
  isSafeFixtureEntries,
  plainUpstream,
  runSettled,
  uncertainRun,
  validExpectedFailure,
  validTestIds,
} from "./causal-verifier-protocol.ts";
import {
  preflightDestinations,
  regularFileAt,
  removeVerified,
  statRegular,
  writeInput,
} from "./causal-verifier-files.ts";

/**
 * Concrete trusted causal verifier (plan 01): one fixed local Deno consumer
 * execution protocol over the SAME original Git revision.
 *
 * The boundary is concrete, not an oracle: the verifier materializes TWO
 * independent exact-original-SHA source snapshots from the configured local
 * Git source (never the shared working directory, never the model/candidate
 * checkout), writes the private original request/upstream into ONE disposable
 * restricted verifier scratch snapshot and the exact composed sanitized
 * bundle into the other, and then executes the SAME committed trusted
 * consumer script in both snapshots by invoking the installed Deno binary
 * DIRECTLY with the fixed no-prompt/no-config/no-remote protocol and read
 * permission confined to that snapshot — no env/network/run/ffi/write
 * permissions, no `deno task`, no target- or request-supplied argv,
 * permissions or matchers. The OS boundary around that invocation is the
 * embedded macOS sandbox-exec seatbelt profile on darwin, and the injected
 * callable replay-isolation capability (bwrap namespace, read-only checkout)
 * on Linux; those are the only two supported platforms.
 * A proof is returned ONLY when BOTH executions are exited and settled,
 * untruncated, exit with code 1, keep stderr empty and print on stdout the
 * EXACT supported safe failure protocol: one `sentinel-replay-test:<id>\n`
 * line per trusted id in trusted order, followed by exactly one fixed
 * `sentinel-causal-failure:stream terminated unexpectedly\n` line. Nothing
 * more, nothing less: any extra/private/unrelated diagnostic line, any
 * duplicate, reordered, missing or extra id, any nonzero stderr stream or
 * any other exit code is NO evidence.
 *
 * The protocol is exact bytes, never a matcher over arbitrary output: the
 * proof carries per-execution OBSERVED evidence (exit code 1, the trusted
 * test identity actually printed, the digest over EXACTLY those validated
 * safe fixed protocol bytes) plus the fixed safe expected-failure identity
 * label. Raw private request/upstream bytes, the private snapshot paths and
 * raw consumer output never leave this module: they stay in a disposable
 * restricted task directory, and the proof carries only digests/
 * classification over the fixed safe protocol. The private original files
 * are never exported, never logged and never placed in the model/candidate
 * checkout. The output digest is an observed-execution binding for
 * already-classified intended failures ONLY over the exact validated safe
 * protocol bytes — arbitrary or private diagnostics are never accepted and
 * never hashed.
 *
 * Dispatch metadata: both snapshots also receive the fixed root
 * `.sentinel-replay-input.json` record — the exact canonical
 * `{version:'v1',requestPath,upstreamPath,testIds}` bytes derived from the
 * already validated fixed consumer paths and the ordered validated trusted
 * test ids (<=16 KiB, no private bytes). The committed consumer reads ONLY
 * this record plus the two paths it names, so a missing dispatcher can never
 * be satisfied by hardcoded fixture reads. The metadata is NOT part of the
 * digested two-entry sanitized bundle: the bundle bytes and digest are
 * unchanged. Both snapshots are preflighted in full (all three destinations,
 * every component) BEFORE any byte is placed; metadata is placed before the
 * private original bytes, and an existing target is accepted only when it is
 * byte-identical and is never rewritten.
 *
 * The OS boundary profile is the FIXED deny-by-default seatbelt profile that
 * the host acceptance receipts validated (byte-copy of the immutable
 * /tmp/sentinel-deno-import-boundary-profile-v3-20260909.sb): it allows the
 * installed Deno binary, its dyld support, the ONE snapshot directory of the
 * current run and that run's OWN cache directory, plus /dev/urandom|null,
 * localtime, sysctl and mach-lookup — nothing else. Network, fork (process
 * execution of anything but the Deno binary), writes outside the cache and
 * reads outside the snapshot/cache are denied by the kernel. Deno's own
 * permissions remain ADDITIONAL restrictions on top of the OS boundary.
 * Cwd is the current snapshot so relative Deno reads resolve inside it.
 *
 * On a non-macOS/non-Linux host, on Linux without a valid injected isolation
 * capability, with a missing sandbox-exec, an unresolved realpath or any
 * sandbox/policy failure the verifier returns NO proof. There is NO
 * Deno-only fallback and NO import-scanner substitute: a real OS boundary is
 * the requirement, not an optimization.
 *
 * Scope: on macOS this is a REAL Deno permission boundary for the supported
 * local consumer (read confined to the snapshot, everything else denied); on
 * Linux the consumer runs inside the injected replay-isolation boundary with
 * the same fixed direct-Deno argv, and trusted Git clone/checkout work stays
 * on the ordinary runtime. Neither path is a general-purpose sandbox for
 * arbitrary target commands — the ReplayPort's callable restricted-execution
 * isolation capability remains the production gate for those.
 */

export type {
  GatewayCausalVerifierInputV1,
  GatewayCausalVerifierV1,
  GatewayLocalCausalVerifierOptionsV1,
} from "./causal-verifier-contracts.ts";
export {
  buildSentinelReplayInputMetadata,
  CAUSAL_CONSUMER_PATH,
  CAUSAL_SANDBOX_EXEC_PATH,
  MAX_SENTINEL_REPLAY_INPUT_BYTES,
  SENTINEL_REPLAY_INPUT_PATH,
} from "./causal-dispatch.ts";
export type { SentinelReplayInputV1 } from "./causal-dispatch.ts";

export class GatewayLocalCausalVerifier implements GatewayCausalVerifierV1 {
  private readonly execution: CausalVerifierExecution;
  constructor(private readonly options: GatewayLocalCausalVerifierOptionsV1) {
    this.execution = new CausalVerifierExecution(options);
  }

  async verify(
    input: GatewayCausalVerifierInputV1,
  ): Promise<GatewayCausalProofV1 | null> {
    // ---- bounded input validation (fail closed; nothing runs yet) ----
    const capture = input.capture as RetainedGatewayCaptureV1 | null;
    if (capture === null || typeof capture !== "object") return null;
    if (!isGitSha(capture.gitSha)) return null;
    const originalSha = capture.gitSha as GitSha;
    const body = capture.body;
    if (!(body instanceof Uint8Array) || body.byteLength === 0) return null;
    const upstream = capture.upstream;
    if (
      upstream === null || typeof upstream !== "object" ||
      !Array.isArray(upstream.attempts) || upstream.attempts.length === 0
    ) {
      return null;
    }
    if (!validTestIds(input.testIds)) return null;
    if (!validExpectedFailure(input.expectedFailure)) return null;
    if (!isSafeFixtureEntries(input.fixtureEntries)) return null;

    const requestBytes = entryBytes(
      input.fixtureEntries,
      this.options.consumerRequestPath,
    );
    const upstreamBytes = entryBytes(
      input.fixtureEntries,
      this.options.consumerUpstreamPath,
    );
    if (requestBytes === null || upstreamBytes === null) return null;
    // Exact composed bundle: the digest over the actual bytes must equal the
    // identity the trusted composition computed.
    const bundleDigest = await computeReplayFixtureDigest(input.fixtureEntries);
    if (bundleDigest !== input.bundleDigest) return null;

    // The original request payload is supported JSON text: decode with FATAL
    // UTF-8 so malformed bytes are rejected before anything is placed.
    const privateText = decodeFatal(body);
    if (privateText === null) return null;

    // Fixed root dispatch metadata over the already validated fixed paths and
    // the ordered validated trusted test ids. Public bytes only; never part
    // of the digested two-entry fixture bundle.
    const metadataBytes = buildSentinelReplayInputMetadata(
      this.options.consumerRequestPath,
      this.options.consumerUpstreamPath,
      input.testIds,
    );
    if (metadataBytes === null) return null;

    // Private original request/upstream bytes: ONLY under the disposable
    // restricted task directory, removed in finally. The consumer protocol
    // is fixed: request.json carries the raw body string; upstream.json
    // carries the raw authenticated upstream trace.
    const originalRequestBytes = encode(
      canonicalStringify({ body: privateText }),
    );
    const originalUpstreamBytes = encode(
      canonicalStringify(plainUpstream(upstream)),
    );

    // ---- platform/boundary preflight (BEFORE any private write) ----
    // macOS keeps the fixed embedded seatbelt profile + installed
    // sandbox-exec. Linux requires the injected callable isolation capability
    // (bwrap namespace); absent/invalid capability is NO proof before any
    // private filesystem write or consumer execution. Unsupported platforms
    // are NO proof. There is no Deno-only or import-scanner fallback.
    if (
      this.execution.osName !== "darwin" && this.execution.osName !== "linux"
    ) return null;
    if (this.execution.osName === "darwin") {
      const sandboxInfo = await statRegular(this.execution.sandboxExecPath);
      if (sandboxInfo === null) return null;
    } else if (this.execution.isolationRunner === null) {
      return null;
    }
    let reader: PreparedCausalReaderV1 | null;
    try {
      reader = await this.execution.selectReader(originalSha);
      if (reader === null) return null;
    } catch {
      return null;
    }

    let taskDir: string | null = null;
    // Uncertainty (an unsettled consumer run) preserves the restricted
    // scratch for inspection: private data is never destroyed while a run
    // cannot be proved settled, and a sanitized run starts only after the
    // original run settled.
    let preserveScratch = false;
    try {
      await Deno.mkdir(this.options.scratchDir, { recursive: true });
      taskDir = await Deno.makeTempDir({
        prefix: "sentinel-causal-verifier-",
        dir: this.options.scratchDir,
      });
      const originalDir = `${taskDir}/original`;
      const sanitizedDir = `${taskDir}/sanitized`;
      const originalHome = `${taskDir}/home-original`;
      const sanitizedHome = `${taskDir}/home-sanitized`;

      // Two INDEPENDENT exact-original-SHA snapshots (two full --no-local
      // clones; never the shared source working directory). Each run gets
      // its OWN home/cache; no cache is shared between the two executions.
      if (reader.kind === "bun") {
        await materializeBunReaderSnapshot(reader, originalDir);
        await materializeBunReaderSnapshot(reader, sanitizedDir);
        const preflight = await this.execution.preflightBunReader(
          originalDir,
          reader,
        );
        if (!runSettled(preflight)) {
          if (uncertainRun(preflight)) preserveScratch = true;
          return null;
        }
        if (
          preflight.exitCode !== 0 || preflight.truncated ||
          preflight.stderr.byteLength !== 0 ||
          decodeFatal(preflight.stdout) !== BUN_READER_PREFLIGHT_STDOUT
        ) return null;
      } else {
        await this.execution.cloneAt(taskDir, originalDir, originalSha);
        await this.execution.cloneAt(taskDir, sanitizedDir, originalSha);
      }

      // The trusted consumer must exist at the exact original SHA as a regular
      // file (never a symlink), and the WHOLE snapshot preflight — the fixed
      // dispatch metadata plus BOTH input paths, every destination of both
      // snapshots, every component of every path — must pass before ANY byte
      // is placed. An existing regular destination is accepted only when it
      // is byte-identical to the exact bytes that would be placed (never
      // rewritten); symlinks, directories, non-regular entries and foreign
      // bytes reject with nothing written.
      const originalFiles: ReplayFixtureEntryV1[] = [
        { path: SENTINEL_REPLAY_INPUT_PATH, bytes: metadataBytes },
        {
          path: this.options.consumerRequestPath,
          bytes: originalRequestBytes,
        },
        {
          path: this.options.consumerUpstreamPath,
          bytes: originalUpstreamBytes,
        },
      ];
      const sanitizedFiles: ReplayFixtureEntryV1[] = [
        { path: SENTINEL_REPLAY_INPUT_PATH, bytes: metadataBytes },
        { path: this.options.consumerRequestPath, bytes: requestBytes },
        { path: this.options.consumerUpstreamPath, bytes: upstreamBytes },
      ];
      for (const dir of [originalDir, sanitizedDir]) {
        if (!(await regularFileAt(dir, this.options.consumerPath))) return null;
      }
      if (!(await preflightDestinations(originalDir, originalFiles))) {
        return null;
      }
      if (!(await preflightDestinations(sanitizedDir, sanitizedFiles))) {
        return null;
      }

      // Metadata first in BOTH snapshots (public, deterministic), then the
      // private original bytes, then the exact sanitized bundle bytes.
      await writeInput(originalDir, SENTINEL_REPLAY_INPUT_PATH, metadataBytes);
      await writeInput(
        sanitizedDir,
        SENTINEL_REPLAY_INPUT_PATH,
        metadataBytes,
      );
      await writeInput(
        originalDir,
        this.options.consumerRequestPath,
        originalRequestBytes,
      );
      await writeInput(
        originalDir,
        this.options.consumerUpstreamPath,
        originalUpstreamBytes,
      );

      // Sanitized snapshot uses the EXACT composed bundle bytes verbatim.
      await writeInput(
        sanitizedDir,
        this.options.consumerRequestPath,
        requestBytes,
      );
      await writeInput(
        sanitizedDir,
        this.options.consumerUpstreamPath,
        upstreamBytes,
      );

      // The SAME original source consumer in both snapshots; only the input
      // bytes differ, and each execution is confined to its own snapshot and
      // its own cache.
      const originalRun = await this.execution.runConsumer(
        originalDir,
        originalHome,
        reader,
      );
      if (!runSettled(originalRun)) {
        // Unsettled original run: abort BEFORE the sanitized execution and
        // preserve the restricted scratch on the uncertainty.
        if (uncertainRun(originalRun)) preserveScratch = true;
        return null;
      }
      const originalObservation = await classifyObservation(
        originalRun,
        input.testIds,
      );
      if (originalObservation === null) {
        // The original execution is settled but did not reproduce the
        // intended failure: abort before the sanitized execution.
        return null;
      }
      const sanitizedRun = await this.execution.runConsumer(
        sanitizedDir,
        sanitizedHome,
        reader,
      );
      if (!runSettled(sanitizedRun)) {
        if (uncertainRun(sanitizedRun)) preserveScratch = true;
        return null;
      }
      const sanitizedObservation = await classifyObservation(
        sanitizedRun,
        input.testIds,
      );
      if (sanitizedObservation === null) {
        return null;
      }
      if (reader.kind === "bun") await prepareBunFrozenReader(reader.binding);

      const expectedFailureIdentity = await deriveExpectedFailureIdentity(
        input.expectedFailure,
      );
      const proof: GatewayCausalProofV1 = {
        version: "v1",
        kind: "gateway_causal_proof",
        verifier: GATEWAY_CAUSAL_VERIFIER_ID,
        proofRef: gatewayCausalProofRef(
          input.incidentId,
          input.captureId,
          bundleDigest,
        ),
        repository: input.repository,
        incidentId: input.incidentId,
        captureId: input.captureId,
        artifactDigest: input.artifactDigest,
        originalGitSha: originalSha,
        fixtureRef: input.fixtureRef,
        bundleDigest,
        replayCommandId: input.replayCommandId,
        testCommandId: input.testCommandId,
        consumerCommandId: CAUSAL_CONSUMER_COMMAND_ID,
        testIds: [...input.testIds],
        expectedFailure: copyExpectedFailure(input.expectedFailure),
        expectedFailureIdentity,
        originalObservation,
        sanitizedObservation,
      };
      // Normal cleanup is VERIFIED before the proof may be returned: a
      // cleanup failure is never swallowed while claiming the private
      // original was removed.
      const removed = await removeVerified(taskDir);
      if (!removed) return null;
      taskDir = null;
      return proof;
    } catch {
      // Any local failure (missing SHA, unsafe target, symlink, git error,
      // deno denial, policy failure, settlement uncertainty) is NO proof —
      // never an allow.
      return null;
    } finally {
      // Best-effort cleanup for settled failures. On uncertainty
      // (preserveScratch) the restricted task directory is KEPT.
      if (taskDir !== null && !preserveScratch) {
        await Deno.remove(taskDir, { recursive: true }).catch(() => {});
      }
    }
  }
}
