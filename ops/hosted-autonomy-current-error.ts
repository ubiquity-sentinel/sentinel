/**
 * Payload-free diagnosis of an error that escapes the current-matrix walk,
 * and the one availability class that defers only that walk.
 *
 * The walk and its producer passes throw fixed messages of their own; any
 * other text (transport, state, decoder or Git output) can carry payload. Only
 * an exact message from this fixed vocabulary reaches the hosted log
 * ("[redacted]" otherwise), and only a fixed class name ("UnknownError"
 * otherwise).
 */
import { CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE } from "./hosted-autonomy-policy.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "./hosted-autonomy-producer-recovery.ts";

/**
 * The exact completed producer's authenticated transport returned no wave:
 * its plan artifact is not listed (gone past retention, or never uploaded).
 * The producer pass throws it as a plain Error before its first custody-bound
 * write, and the walk only reaches a producer after every earlier pass applied
 * nothing (an applied pass ends the walk), so the walk has written nothing.
 */
export const CURRENT_MATRIX_WAVE_UNAVAILABLE =
  "current matrix wave unavailable";

/** Every fixed refusal the walk, its passes and its transport throw. */
const MESSAGES: ReadonlySet<string> = new Set([
  CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE,
  CURRENT_MATRIX_WAVE_UNAVAILABLE,
  "current matrix history cycle",
  "current matrix history root unavailable",
  "current matrix history unavailable",
  "current matrix history ancestry unavailable",
  "current matrix historical proof conflicts",
  "current matrix producer custody unavailable",
  "current matrix producer ancestry changed",
  "current matrix release custody changed",
  "current matrix repair custody changed",
  "current matrix request binding unavailable",
  "current matrix native proof unavailable",
  "current matrix native proof changed",
  "current matrix wave binding changed",
  "current matrix blocked implementation binding changed",
  "current matrix ingestion incomplete",
  "current matrix conflict preservation readback changed",
  "current matrix candidate preservation readback changed",
  "current matrix selected evidence unavailable",
  "current matrix readback incomplete",
  "matrix artifact provenance unavailable or conflicting",
  "matrix artifact API unavailable",
  "matrix native job log not served yet",
  "authenticated historical matrix runtime mismatch",
]);

const NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "CurrentMatrixRecoveryIntegrityFailure",
]);

export interface CurrentMatrixErrorDiagnosticV1 {
  kind: "sentinel_current_matrix_error";
  name: string;
  message: string;
  integrity: boolean;
  /** True only for the plain wave refusal: the walk alone is deferred. */
  deferred: boolean;
}

/** One read of each field; a throwing accessor reads as unknown. */
function field(error: Error, key: "name" | "message"): unknown {
  try {
    return error[key];
  } catch {
    return undefined;
  }
}

/**
 * The fixed diagnostic for one escaping walk error. Only a base `Error` (never
 * a subclass, so never an integrity or other typed failure) carrying exactly
 * the wave refusal is deferred; custody, integrity, accounting and every
 * unknown refusal keep stopping the maintenance pass as before.
 */
export function currentMatrixErrorDiagnostic(
  error: unknown,
): CurrentMatrixErrorDiagnosticV1 {
  let name: unknown;
  let message: unknown;
  let plain = false;
  let integrity = false;
  try {
    if (error instanceof Error) {
      name = field(error, "name");
      message = field(error, "message");
      plain = Object.getPrototypeOf(error) === Error.prototype;
      integrity = error instanceof CurrentMatrixRecoveryIntegrityFailure;
    }
  } catch {
    // An exotic thrown value stays unknown and is never deferred.
    plain = false;
  }
  return {
    kind: "sentinel_current_matrix_error",
    name: typeof name === "string" && NAMES.has(name) ? name : "UnknownError",
    message: typeof message === "string" && MESSAGES.has(message)
      ? message
      : "[redacted]",
    integrity,
    deferred: plain && !integrity &&
      message === CURRENT_MATRIX_WAVE_UNAVAILABLE,
  };
}
