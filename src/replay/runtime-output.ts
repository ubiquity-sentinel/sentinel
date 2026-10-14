/**
 * Concurrent, bounded collector for both streams. One shared byte budget
 * covers the combined retained output (stdout + stderr), matching the
 * registry contract; the retained prefix is what digests cover and any
 * overage sets `truncated`. Both streams are drained concurrently to EOF so
 * a full pipe can never deadlock the run. An optional advisory observer sees
 * exactly the retained stdout chunks, and never stderr.
 */
export class BoundedCollector {
  truncated = false;
  private remaining: number;
  private readonly stdoutChunks: Uint8Array[] = [];
  private readonly stderrChunks: Uint8Array[] = [];
  private stdoutTotal = 0;
  private stderrTotal = 0;

  constructor(
    budget: number,
    private readonly onStdoutChunk?: (chunk: Uint8Array) => void,
  ) {
    this.remaining = budget;
  }

  stdout(): Uint8Array {
    return joinChunks(this.stdoutChunks, this.stdoutTotal);
  }

  stderr(): Uint8Array {
    return joinChunks(this.stderrChunks, this.stderrTotal);
  }

  async collect(
    stream: AsyncIterable<Uint8Array> | null,
    slot: "stdout" | "stderr",
  ): Promise<void> {
    if (stream === null) return;
    const chunks = slot === "stdout" ? this.stdoutChunks : this.stderrChunks;
    const observer = slot === "stdout" ? this.onStdoutChunk : undefined;
    for await (const value of stream) {
      if (this.remaining === 0) {
        this.truncated = true;
        continue;
      }
      const take = Math.min(value.byteLength, this.remaining);
      const retained = value.subarray(0, take);
      chunks.push(retained);
      if (slot === "stdout") {
        this.stdoutTotal += take;
      } else {
        this.stderrTotal += take;
      }
      this.remaining -= take;
      if (take < value.byteLength) this.truncated = true;
      // Advisory observer: only retained stdout bytes, never stderr. A thrown
      // observer must not disturb capture, draining, the deadline or
      // settlement, so it is swallowed here.
      if (observer !== undefined && take > 0) {
        try {
          observer(retained);
        } catch {
          // Advisory only: the run continues exactly as if it were absent.
        }
      }
    }
  }
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
