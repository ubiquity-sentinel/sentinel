/** Bounded numeric-only refusal coordinates from closed code-owned sources. */

const NATIVE_STACK_GETTER = Object.getOwnPropertyDescriptor(
  new Error(),
  "stack",
)?.get;
const ERROR_PROTOTYPES = new Set([
  Error.prototype,
  EvalError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  TypeError.prototype,
  URIError.prototype,
  AggregateError.prototype,
  Object.prototype,
]);
export function refusalFrames(
  error: unknown,
): { line: number; column: number }[] {
  let stack: unknown;
  try {
    const descriptor = error !== null &&
        (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "stack")
      : undefined;
    if (descriptor && "value" in descriptor) {
      stack = descriptor.value;
    } else if (NATIVE_STACK_GETTER && descriptor?.get === NATIVE_STACK_GETTER) {
      for (const object of [Error, Function.prototype, Object.prototype]) {
        const hook = Object.getOwnPropertyDescriptor(
          object,
          "prepareStackTrace",
        );
        if (hook && (!("value" in hook) || hook.value !== undefined)) return [];
      }
      let object = error;
      for (let depth = 0; object !== null; depth++) {
        if (
          depth > 3 ||
          (object !== error && !ERROR_PROTOTYPES.has(object as object))
        ) return [];
        for (const key of ["name", "message"]) {
          const value = Object.getOwnPropertyDescriptor(object, key);
          if (
            value &&
            (!("value" in value) ||
              (typeof value.value !== "string" && value.value !== undefined))
          ) return [];
        }
        object = Object.getPrototypeOf(object);
      }
      stack = NATIVE_STACK_GETTER.call(error);
    }
  } catch {
    return [];
  }
  const frames: { line: number; column: number }[] = [];
  if (typeof stack !== "string") return frames;
  const pattern =
    /^[ \t]+at[ \t]+(?:[^\r\n]*[ \t]+\()?file:\/\/\/[^\r\n]*\/(?:matrix-artifacts|matrix-artifact-values|matrix-artifact-http|matrix-artifact-archive|matrix-artifact-native|matrix-artifact-wave)\.ts:([1-9][0-9]{0,5}):([1-9][0-9]{0,5})\)?[ \t]*$/gm;
  for (const frame of stack.slice(0, 8192).matchAll(pattern)) {
    frames.push({ line: Number(frame[1]), column: Number(frame[2]) });
    if (frames.length === 3) break;
  }
  return frames;
}
