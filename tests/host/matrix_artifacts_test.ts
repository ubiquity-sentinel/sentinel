/** Numeric-only refusal diagnostics preserve source coordinates and custody. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";
import { fixture, RUN, WAVE } from "./matrix-artifact-fixtures.ts";

Deno.test("matrix artifacts: recovery refusal coordinates are bounded and preserve custody", async (t) => {
  const sources = {
    identity: (await Deno.readTextFile(
      new URL("../../src/host/matrix-artifact-wave.ts", import.meta.url),
    )).split("\n"),
    custody: (await Deno.readTextFile(
      new URL("../../src/host/matrix-artifact-native.ts", import.meta.url),
    )).split("\n"),
    http: (await Deno.readTextFile(
      new URL("../../src/host/matrix-artifact-http.ts", import.meta.url),
    )).split("\n"),
  };
  const callers = new Set<number>();
  for (
    const fault of [
      "identity",
      "custody",
      "json",
      "accessor",
      "name",
      "message",
      "inherited-name",
      "inherited-message",
      "prepare",
      "missing",
      "trap",
      "spoof",
      "oversized",
      "logger",
    ]
  ) {
    await t.step(fault, async () => {
      const source = sources[
        fault === "identity" || fault === "custody" ? fault : "http"
      ];
      const f = await fixture();
      const cwd = Deno.cwd();
      const originalError = console.error;
      const originalHook = Object.getOwnPropertyDescriptor(
        Error,
        "prepareStackTrace",
      );
      const output: string[] = [];
      let reads = 0, releaseReads = 0, writes = 0;
      const secret = "private-token https://private.invalid/raw";
      const injected = new Error(secret);
      if (fault === "accessor") {
        Object.defineProperty(injected, "stack", {
          get() {
            reads++;
            return secret;
          },
        });
      } else if (fault === "name" || fault === "message") {
        Object.defineProperty(injected, fault, {
          get() {
            reads++;
            return secret;
          },
        });
      } else if (fault.startsWith("inherited-")) {
        Object.setPrototypeOf(
          injected,
          Object.create(Error.prototype, {
            [fault.slice("inherited-".length)]: {
              get() {
                reads++;
                return secret;
              },
            },
          }),
        );
      } else if (fault === "spoof") {
        Object.defineProperty(injected, "stack", {
          value:
            `Error: ${secret}\n    at private (file:///private/matrix-artifacts.ts:42:7)\n    at private (file:///private/matrix-artifacts.ts:43:8)\n    at private (file:///private/matrix-artifacts.ts:44:9)\n    at private (file:///private/matrix-artifacts.ts:45:10)\n    at private (file:///private/matrix-artifacts.ts:999999999:1)`,
        });
      } else if (fault === "oversized") {
        Object.defineProperty(injected, "stack", {
          value: `${
            secret.repeat(1000)
          }\n    at private (file:///private/matrix-artifacts.ts:42:7)`,
        });
      }
      const execution = {
        ...f.release.hostedRuntimes[0].execution!,
        id: WAVE,
        ...RUN,
      };
      f.release.hostedRuntimes[0].execution = execution;
      f.attempt.status = "completed";
      if (fault === "identity") f.attempt.workflow_id = 1;
      const before = canonicalStringify({
        repair: f.repair,
        release: f.release,
      });
      const transport = createActionsMatrixArtifactTransport({
        state: {
          readRepair: f.state.readRepair,
          readRelease: () => {
            releaseReads++;
            return Promise.resolve(
              portOk({
                status: "found",
                snapshot: f.release,
                head: fault === "custody" && releaseReads > 1 ? SHA2 : SHA1,
                ref: null,
              }),
            );
          },
        },
        token: "fake-local-token",
        clock: { now: () => T0 + 10_000 },
        artifactRoot: `${f.tmp}/diagnostic`,
        http: (request) => {
          if (request.method !== "GET") writes++;
          if (
            [
              "accessor",
              "name",
              "message",
              "inherited-name",
              "inherited-message",
              "prepare",
              "spoof",
              "oversized",
            ].includes(fault)
          ) return Promise.reject(injected);
          if (fault === "missing") return Promise.reject({ message: secret });
          if (fault === "trap") {
            return Promise.reject(
              new Proxy({}, {
                getOwnPropertyDescriptor() {
                  reads++;
                  throw injected;
                },
              }),
            );
          }
          if (fault === "json") {
            return Promise.resolve({
              status: 200,
              headers: new Headers(),
              bodyText: secret,
            });
          }
          return f.http(request);
        },
      });
      console.error = (...args: unknown[]) => {
        if (fault === "logger") throw injected;
        output.push(args.join(" "));
      };
      Deno.chdir(`${f.tmp}/checkout`);
      try {
        const run = fault === "identity" || fault === "logger"
          ? () => transport.recover(f.input)
          : () => transport.confirmCompletedExecution!(execution);
        if (fault === "logger") f.attempt.workflow_id = 1;
        if (fault === "prepare") {
          Object.defineProperty(Error, "prepareStackTrace", {
            configurable: true,
            value() {
              reads++;
              return secret;
            },
          });
        }
        let thrown: unknown;
        try {
          await run();
        } catch (error) {
          thrown = error;
        }
        if (originalHook) {
          Object.defineProperty(Error, "prepareStackTrace", originalHook);
        } else Reflect.deleteProperty(Error, "prepareStackTrace");
        assert.ok(thrown instanceof Error);
        assert.equal(thrown.name, "Error");
        assert.equal(
          thrown.message,
          "matrix artifact provenance unavailable or conflicting",
        );
        assert.equal(writes, 0);
        assert.equal(
          canonicalStringify({ repair: f.repair, release: f.release }),
          before,
        );
        assert.deepEqual([...Deno.readDirSync(`${f.tmp}/diagnostic`)], []);
        if (fault === "logger") return;
        assert.equal(
          output.length,
          1,
          "recovery catch must expose the original throw coordinates",
        );
        const diagnostic = JSON.parse(output[0]);
        assert.deepEqual(Object.keys(diagnostic).sort(), ["frames", "kind"]);
        assert.equal(diagnostic.kind, "sentinel_matrix_artifact_error");
        assert.equal(
          /private|token|https|file:|matrix-artifacts|fake-local/.test(
            output[0],
          ),
          false,
        );
        assert.ok(output[0].length <= 180);
        const frames = diagnostic.frames as { line: number; column: number }[];
        assert.ok(frames.length <= 3);
        for (const frame of frames) {
          assert.deepEqual(Object.keys(frame).sort(), ["column", "line"]);
          assert.ok(
            Number.isSafeInteger(frame.line) && frame.line > 0 &&
              frame.line <= 999999,
          );
          assert.ok(
            Number.isSafeInteger(frame.column) && frame.column > 0 &&
              frame.column <= 999999,
          );
        }
        if (["identity", "custody", "json"].includes(fault)) {
          assert.ok(
            frames.length > 0,
            "real Deno consumer failure must retain its source site",
          );
          const caller = frames.find((frame) =>
            fault === "json"
              ? source[frame.line - 1]?.includes("JSON.parse")
              : source[frame.line - 1]?.includes("refuse()")
          );
          assert.ok(caller);
          assert.ok(caller.line <= source.length);
          assert.match(
            source[caller.line - 1],
            fault === "json" ? /JSON\.parse/ : /refuse\(\)/,
          );
          callers.add(caller.line);
          console.log(
            JSON.stringify({
              kind: "matrix_artifact_test_frames",
              fault,
              frames,
            }),
          );
        } else if (fault === "spoof") {
          assert.deepEqual(frames, [{ line: 42, column: 7 }, {
            line: 43,
            column: 8,
          }, { line: 44, column: 9 }]);
        } else {
          assert.deepEqual(frames, []);
        }
        assert.equal(reads, fault === "trap" ? 1 : 0);
      } finally {
        if (originalHook) {
          Object.defineProperty(Error, "prepareStackTrace", originalHook);
        } else Reflect.deleteProperty(Error, "prepareStackTrace");
        console.error = originalError;
        Deno.chdir(cwd);
        await Deno.remove(f.tmp, { recursive: true });
      }
    });
  }
  assert.equal(
    callers.size,
    3,
    "identity, custody and JSON failures need distinct source sites",
  );
});
