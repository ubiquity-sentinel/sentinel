/** Authenticated lazy ZIP extraction with finite content and filesystem bounds. */
import {
  MAX_MATRIX_ARCHIVE_BYTES,
  MAX_MATRIX_ARTIFACT_BYTES,
  MAX_MATRIX_BUNDLE_BYTES,
} from "../contracts/matrix.ts";
import {
  bytesDigest,
  type Json,
  positive,
  refuse,
} from "./matrix-artifact-values.ts";
import type {
  MatrixArtifactDeadlineV1,
  MatrixArtifactReaderV1,
} from "./matrix-artifact-context.ts";

export function createMatrixArtifactArchive(
  download: MatrixArtifactReaderV1["download"],
  deadline: MatrixArtifactDeadlineV1,
  controller: AbortController,
) {
  const archive = async (
    artifact: Json,
  ): Promise<Map<string, Uint8Array>> => {
    if (
      artifact.expired !== false || typeof artifact.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      (artifact.size_in_bytes as number) <= 0 ||
      (artifact.size_in_bytes as number) > MAX_MATRIX_ARCHIVE_BYTES
    ) refuse();
    const response = await download(
      `/artifacts/${positive(artifact.id)}/zip`,
      true,
    );
    const bytes = response.bodyBytes;
    if (
      !bytes || bytes.length !== artifact.size_in_bytes ||
      `sha256:${await bytesDigest(bytes)}` !== artifact.digest
    ) refuse();
    // NOTE: the npm specifier MUST stay non-literal. Deno prefetches
    // every statically-discoverable import at startup (including
    // literal dynamic imports), so a literal specifier here
    // re-introduces the bootstrap npm fetch hang. The computed string
    // keeps zip.js truly lazy: it loads only when an artifact zip is
    // actually read.
    const zipSpec = ["npm:@zip.js/zip.js", "2.8.34"].join("@");
    const { Uint8ArrayReader, ZipReader } = await import(zipSpec);
    const reader = new ZipReader(new Uint8ArrayReader(bytes), {
      useWebWorkers: false,
      strictness: "strict",
      checkSignature: true,
      checkOverlappingEntry: true,
    });
    const files = new Map<string, Uint8Array>();
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        const name = entry.filename;
        const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        const limit = name.endsWith(".bundle")
          ? MAX_MATRIX_BUNDLE_BYTES
          : MAX_MATRIX_ARTIFACT_BYTES;
        if (
          files.size >= 2 || files.has(name) ||
          !/^(?:plan\.json|result\.json|[0-9a-f]{64}\.bundle)$/.test(
            name,
          ) || entry.directory || entry.encrypted ||
          (type !== 0 && type !== 0x8000) || entry.setuid ||
          entry.setgid || entry.executable ||
          entry.uncompressedSize < 0 || entry.uncompressedSize > limit ||
          !Number.isSafeInteger(entry.uncompressedSize)
        ) refuse();
        const chunks: Uint8Array[] = [];
        let length = 0;
        await deadline.race(
          entry.getData(
            new WritableStream<Uint8Array>({
              write(chunk) {
                length += chunk.length;
                if (length > limit) refuse();
                chunks.push(chunk.slice());
              },
            }),
            { signal: controller.signal, checkSignature: true },
          ),
        );
        if (length !== entry.uncompressedSize) refuse();
        const content = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          content.set(chunk, offset);
          offset += chunk.length;
        }
        files.set(name, content);
      }
    } finally {
      await reader.close();
    }
    return files;
  };

  return archive;
}
