/**
 * m04-repair: runtime ImplementationPort backed by a bounded Codex app-server
 * session (route-selected model id / max requested explicitly).
 *
 * Fail-closed receipt policy (frozen ImplementationPort has no authoritative
 * observation method or pre-call provider id): the session host supplies an
 * injectable ReceiptVerifier. The default verifier never certifies actual
 * provider model/effort, so the port returns `unavailable` and records the
 * live activation boundary — observed values are never synthesized from the
 * requested strings. An EXPLICIT valid `modelProvider` is required before ANY
 * session opens (including the custom-verifier path): a missing provider
 * stays unavailable and a callback never enables a missing provider. With a
 * selected provider the port binds the real request/runtime receipt producer
 * (`createRequestRuntimeReceiptVerifier(expectedProvider, expectedModel)`):
 * the receipt then proofs trusted submitted provider/model/effort
 * configuration bound to the
 * exact invocation/thread/turn and runtime routing/terminal events, labeled
 * request/runtime evidence — never backend provider attestation. A supplied
 * custom verifier remains only an ADDITIONAL restriction after the concrete
 * core request/runtime checks; with no provider and no verifier the default
 * stays unavailable and no model budget is ever spent on a run the controller
 * cannot attribute; the repair loop settles the durable reservation ambiguous
 * (charged) and blocks the task.
 *
 * Correlation, routing and model-policy validation are port duties and cannot
 * be bypassed by an injected verifier: the port binds the exact session
 * identity/thread/turn, rejects any matching reroute off the configured
 * runtime model (even when routed back later), never synthesizes an actual
 * identity or route fallback, and requires nonempty correlated output evidence
 * for a completed run. Protocol or routing uncertainty (malformed reroute/
 * terminal identity, off-policy route, registration failure) sets a sticky
 * unavailable-evidence disposition: finishReceipt returns `unavailable`
 * before ANY verifier or candidate action — such uncertainty is never
 * certified as a valid failed runtime receipt. A HOST timeout (bounds elapsed
 * without a runtime terminal) may retain failed ACCOUNTING with an explicit
 * `host-timeout` terminal origin and the exact invocation/thread/turn
 * identities, but never claims an observed terminal (observed status null).
 * Failed/interrupted receipts may lack output; they are kept for accounting
 * and can never authorize a successful candidate.
 *
 * The port never invents CLI flags/stdin controls or unsupported protocol
 * methods: thread and turn parameters come from the frozen installed schema
 * (`thread/start`, `turn/start`, `turn/interrupt`, `turn/completed`), command
 * and edit items arrive as `item/started` / `item/completed` with an item
 * `type` of `commandExecution` or `fileChange`, terminal settlement is
 * awaited, and every owned timer and stream is cleared. The thread sandbox is
 * the narrowest write-capable mode (`workspace-write` over the isolated
 * checkout cwd): the session can produce its commit inside the checkout but
 * holds no read access outside it and no approval authority.
 */

export { LOOP_STOP_MARKER } from "./model-port-policy.ts";
export type {
  ActualSessionEvidenceV1,
  ModelRerouteV1,
  ReceiptVerifierV1,
  SessionResultItemV1,
  VerifiedRuntimeValuesV1,
} from "./model-port-receipt.ts";
export {
  createRequestRuntimeReceiptVerifier,
  unavailableReceiptVerifier,
} from "./model-port-receipt.ts";
export type {
  CandidateCommitterV1,
  CheckoutResolverV1,
} from "./model-port-checkout.ts";
export {
  LocalCandidateCommitter,
  LocalCheckoutResolver,
} from "./model-port-checkout.ts";
export type { CodexImplementationPortOptionsV1 } from "./model-port-session.ts";
export { CodexImplementationPort } from "./model-port-session.ts";
