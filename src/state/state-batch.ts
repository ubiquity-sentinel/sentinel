import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";

/** Decode exactly one Git --batch blob frame per requested id, in order. */
export function parseBlobBatch(
  output: Uint8Array,
  requested: readonly string[],
): PortResultV1<string[]> {
  // Preserve a BOM rather than silently stripping bytes that canonical
  // JSON validation must reject. Invalid UTF-8 must never become U+FFFD.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const texts: string[] = [];
  let offset = 0;
  for (const sha of requested) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) {
      return portError("invalid", "state blob batch has a truncated header");
    }
    let headerText: string;
    try {
      headerText = decoder.decode(output.subarray(offset, newline));
    } catch {
      return portError("invalid", "state blob batch header is not valid UTF-8");
    }
    // --batch exits successfully for a missing object, unlike cat-file blob.
    // Retain the original unavailable category rather than calling it invalid.
    if (headerText === `${sha} missing`) {
      return portError(
        "unavailable",
        "state remote cat-file failed; the remote ref state is unknown",
      );
    }
    const header = /^([0-9a-f]{40}) blob (0|[1-9][0-9]*)$/.exec(headerText);
    if (header === null || header[1] !== sha) {
      return portError(
        "invalid",
        "state blob batch has an unexpected object header",
      );
    }
    const length = Number(header[2]);
    const start = newline + 1;
    if (
      !Number.isSafeInteger(length) ||
      length > output.length - start - 1 ||
      output[start + length] !== 10
    ) {
      return portError(
        "invalid",
        "state blob batch has an invalid byte length or separator",
      );
    }
    try {
      texts.push(decoder.decode(output.subarray(start, start + length)));
    } catch {
      return portError(
        "invalid",
        "state blob batch content is not valid UTF-8",
      );
    }
    offset = start + length + 1;
  }
  if (offset !== output.length) {
    return portError(
      "invalid",
      "state blob batch has unexpected trailing output",
    );
  }
  return portOk(texts);
}
