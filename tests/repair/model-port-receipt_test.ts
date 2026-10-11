/** Cohesive receipt cases for the unchanged model-port facade. */
import assert from "node:assert/strict";
import { createRequestRuntimeReceiptVerifier } from "../../src/repair/model-port.ts";
import type { ModelRerouteV1 } from "../../src/repair/model-port.ts";
import { requestRuntimeEvidence } from "./model-port-helpers.ts";

Deno.test(
  "request/runtime verifier: certifies correlated completed evidence and returns validated values only",
  () => {
    const verified = createRequestRuntimeReceiptVerifier("sentinel-host")(
      requestRuntimeEvidence(),
    );
    assert.deepEqual(verified, {
      provider: "sentinel-host",
      observedModel: "gpt-reserve",
      observedReasoning: "max",
    });
  },
);

Deno.test(
  "request/runtime verifier: never trusts caller strings as provider attestation and fails closed on mismatched identity/policy",
  () => {
    const verify = createRequestRuntimeReceiptVerifier("sentinel-host");
    // A caller-claimed provider string is never returned as attestation; the
    // expected provider is the only trusted provider identity.
    assert.equal(
      verify(requestRuntimeEvidence({ threadModelProvider: "other-provider" })),
      null,
      "acknowledged provider does not match the selected provider",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ requestedProvider: "other-provider" })),
      null,
      "requested provider does not match the selected provider",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ threadModel: "gpt-5.4" })),
      null,
      "thread model is not Luna",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ threadEffort: "medium" })),
      null,
      "thread effort is not max",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ requestedModel: "gpt-5.4" })),
      null,
      "requested model is not Luna",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ requestedEffort: "medium" })),
      null,
      "requested effort is not max",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ threadId: "" })),
      null,
      "empty thread id",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ turnId: "" })),
      null,
      "empty turn id",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ invocationId: "" })),
      null,
      "empty invocation id",
    );
    // The verifier itself never accepts an invalid expected provider.
    assert.equal(
      createRequestRuntimeReceiptVerifier("")(
        requestRuntimeEvidence(),
      ),
      null,
      "invalid expected provider",
    );
  },
);

Deno.test(
  "request/runtime verifier: ignores well-formed unrelated reroutes",
  () => {
    const reroutes: ModelRerouteV1[] = [{
      threadId: "thread-9",
      turnId: "turn-9",
      from: "gpt-reserve",
      to: "gpt-5.4",
      reason: "capacity",
    }];
    assert.ok(
      createRequestRuntimeReceiptVerifier("sentinel-host")(
        requestRuntimeEvidence({ reroutes }),
      ) !== null,
      "a well-formed reroute for another thread/turn is ignored",
    );
  },
);

Deno.test(
  "request/runtime verifier: any matching reroute off required Luna fails even when routed back",
  () => {
    const verify = createRequestRuntimeReceiptVerifier("sentinel-host");
    const offAndBack: ModelRerouteV1[] = [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-reserve",
        to: "gpt-5.4",
        reason: "off",
      },
      {
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-5.4",
        to: "gpt-reserve",
        reason: "back",
      },
    ];
    assert.equal(
      verify(requestRuntimeEvidence({ reroutes: offAndBack })),
      null,
      "off Luna then routed back still fails",
    );
  },
);

Deno.test("request/runtime verifier: malformed matching reroute fails closed", () => {
  const verify = createRequestRuntimeReceiptVerifier("sentinel-host");
  assert.equal(
    verify(requestRuntimeEvidence({
      reroutes: [{
        threadId: "thread-1",
        turnId: "turn-1",
        from: "",
        to: "gpt-5.4",
        reason: null,
      }],
    })),
    null,
    "unbounded from model",
  );
  assert.equal(
    verify(requestRuntimeEvidence({
      reroutes: [{
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-reserve",
        to: "gpt-reserve",
        reason: null,
      }],
    })),
    null,
    "identity reroute is malformed",
  );
  assert.equal(
    verify(requestRuntimeEvidence({
      reroutes: [{
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-5.4",
        to: "gpt-reserve",
        reason: null,
      }],
    })),
    null,
    "routed back from another model still fails",
  );
  assert.equal(
    verify(requestRuntimeEvidence({
      reroutes: [{
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-reserve",
        to: "gpt-5.4",
        reason: "",
      }],
    })),
    null,
    "unbounded reason",
  );
});

Deno.test(
  "request/runtime verifier: completed needs nonempty output; failed/interrupted and host-timeout retain without it",
  () => {
    const verify = createRequestRuntimeReceiptVerifier("sentinel-host");
    assert.equal(
      verify(requestRuntimeEvidence({ resultItems: [] })),
      null,
      "completed without correlated output is not certified",
    );
    assert.ok(
      verify(requestRuntimeEvidence({
        resultItems: [],
        terminal: { status: "interrupted", error: null, durationMs: null },
      })) !== null,
      "interrupted receipts may lack output and stay certifiable",
    );
    assert.ok(
      verify(requestRuntimeEvidence({
        resultItems: [],
        terminal: { status: "failed", error: "synthetic", durationMs: null },
      })) !== null,
      "failed receipts may lack output and stay certifiable",
    );
    // Host-timeout accounting: no observed terminal (null status) with the
    // explicit `host-timeout` origin stays certifiable WITHOUT claiming a
    // terminal was observed; output is not required for failed accounting.
    assert.deepEqual(
      verify(requestRuntimeEvidence({
        resultItems: [],
        terminal: { status: null, error: null, durationMs: null },
        terminalOrigin: "host-timeout",
      })),
      {
        provider: "sentinel-host",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
      },
      "host-timeout stays certifiable as failed accounting without an observed terminal",
    );
    // Origin consistency: an observed terminal is only runtime evidence; a
    // null observed status is only host-timeout evidence.
    assert.equal(
      verify(requestRuntimeEvidence({
        terminal: { status: null, error: null, durationMs: null },
      })),
      null,
      "runtime origin with no observed terminal is never certified",
    );
    assert.equal(
      verify(requestRuntimeEvidence({
        terminalOrigin: "host-timeout",
      })),
      null,
      "host-timeout origin with an observed terminal is never certified",
    );
    // Loop-stop race: a completed runtime terminal with no output is only
    // certifiable when the host itself stopped the run — after which only
    // interrupted/no-candidate accounting is permitted.
    assert.ok(
      verify(requestRuntimeEvidence({
        resultItems: [],
        loopStopped: true,
      })) !== null,
      "host-stopped completed race may be certified for interrupted accounting",
    );
  },
);
