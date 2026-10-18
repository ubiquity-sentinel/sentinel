/** Host-owned early notification custody, before turn/start can respond. */
import type {
  CodexServerNotificationV1,
  CodexServerRequestV1,
  CodexSessionV1,
} from "./codex-transport.ts";

type Consumer = (event: CodexServerNotificationV1) => void | Promise<void>;
const MiB = 1024 * 1024;
const STORAGE_BOUNDS = {
  general: 8 * MiB,
  terminal: 4 * MiB,
  routing: 4 * MiB,
};
const OUTPUT_ONLY = new Set([
  "item/commandExecution/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
]);

/**
 * The app-server may write its entire turn before acknowledging turn/start.
 * Waiting to register the real consumer until that acknowledgement deadlocks
 * a bounded transport queue. Register immediately and spool projected frames
 * to one owned, unlinked file instead. Known output-only deltas are counted
 * without storage. The file has separate general/terminal/routing budgets so
 * output evidence cannot crowd out terminal or routing evidence. Exceeding a
 * budget loses proof, never interrupts the session. The loss is reported only
 * at settlement. Replay uses one bounded chunk plus one projected frame,
 * preserves wire order and original-volume metadata, and always finishes
 * before the caller can capture a settled receipt.
 *
 * The file is created only if an early notification arrives. Its host cwd is
 * trusted, unlike the model checkout path; unlinking immediately leaves no
 * checkout artifact or pathname through which the model can replace evidence.
 */
export class EarlyNotificationSession implements CodexSessionV1 {
  private consumer: Consumer | null = null;
  private spool: Deno.FsFile | null = null;
  private spoolPath: string | null = null;
  private delivery: Promise<void> | null = null;
  private criticalEvidenceLost = false;
  private storageFailed = false;
  private droppedChars = 0;
  private storedChars = 0;
  private replayedChars = 0;
  private replayFailed = false;
  private storedBytes = { general: 0, terminal: 0, routing: 0 };
  private closed = false;

  constructor(private readonly inner: CodexSessionV1) {
    inner.onNotification((event) => this.receive(event));
  }

  open(): void {
    this.inner.open?.();
  }

  send(method: string, params: unknown): Promise<unknown> {
    return this.inner.send(method, params);
  }

  notify(method: string, params?: unknown): void {
    this.inner.notify(method, params);
  }

  onServerRequest(
    handler: (request: CodexServerRequestV1) => void | Promise<void>,
  ): void {
    this.inner.onServerRequest(handler);
  }

  onNotification(handler: Consumer): void {
    if (this.consumer !== null) {
      throw new Error("notification consumer already registered");
    }
    this.consumer = handler;
    if (this.spool !== null) {
      this.track(
        this.replay(this.spool, handler).catch(() => {
          this.criticalEvidenceLost = true;
          this.replayFailed = true;
        }),
      );
    }
  }

  private receive(event: CodexServerNotificationV1): void | Promise<void> {
    if (this.closed) return;
    const consumer = this.consumer;
    if (consumer === null) {
      const observedChars = this.observedChars(event);
      if (OUTPUT_ONLY.has(event.method)) {
        this.drop(observedChars, false);
        return;
      }
      const kind = event.method === "turn/completed"
        ? "terminal"
        : event.method === "model/rerouted"
        ? "routing"
        : "general";
      const bytes = new TextEncoder().encode(JSON.stringify(event) + "\n");
      if (
        this.storageFailed ||
        bytes.length > STORAGE_BOUNDS[kind] - this.storedBytes[kind]
      ) {
        this.drop(observedChars, true);
        return;
      }
      try {
        if (this.spool === null) {
          const path =
            `${Deno.cwd()}/.sentinel-notifications-${crypto.randomUUID()}`;
          this.spool = Deno.openSync(path, {
            read: true,
            write: true,
            createNew: true,
            mode: 0o600,
          });
          this.spoolPath = path;
          Deno.removeSync(path);
          this.spoolPath = null;
        }
        for (let offset = 0; offset < bytes.length;) {
          const written = this.spool.writeSync(bytes.subarray(offset));
          if (written <= 0) throw new Error("notification spool write stalled");
          offset += written;
        }
        this.storedBytes[kind] += bytes.length;
        this.storedChars = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.storedChars + observedChars,
        );
      } catch {
        this.storageFailed = true;
        this.drop(observedChars, true);
      }
      return;
    }
    // A real transport awaits this promise before reading the next frame.
    // The chain also preserves ordering for synchronous fixture producers.
    if (this.delivery !== null) {
      return this.track(
        this.delivery.then(() => consumer(event)).catch(() => {
          this.criticalEvidenceLost = true;
        }),
      );
    }
    return consumer(event);
  }

  private async replay(file: Deno.FsFile, consumer: Consumer): Promise<void> {
    await file.seek(0, Deno.SeekMode.Start);
    const bytes = new Uint8Array(64 * 1024);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    for (;;) {
      const length = await file.read(bytes);
      pending += length === null
        ? decoder.decode()
        : decoder.decode(bytes.subarray(0, length), { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const text = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        // Only host-serialized transport events enter this unlinked file.
        const event = JSON.parse(text) as CodexServerNotificationV1;
        await consumer(event);
        this.replayedChars = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.replayedChars + this.observedChars(event),
        );
      }
      if (length === null) {
        if (pending !== "") throw new Error("incomplete notification spool");
        return;
      }
    }
  }

  private observedChars(event: CodexServerNotificationV1): number {
    return event.outputVolume?.observedParamsChars ??
      JSON.stringify(event.params ?? {}).length;
  }

  private drop(chars: number, critical: boolean): void {
    this.droppedChars = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.droppedChars + chars,
    );
    this.criticalEvidenceLost ||= critical;
  }

  private track(delivery: Promise<void>): Promise<void> {
    this.delivery = delivery;
    void delivery.then(() => {
      if (this.delivery === delivery) this.delivery = null;
    });
    return delivery;
  }

  /** Counts dropped original payloads, never retained/replayed payloads twice. */
  getEarlyEvidence(): {
    observedParamsChars: number;
    criticalEvidenceLost: boolean;
  } {
    return {
      observedParamsChars: Math.min(
        Number.MAX_SAFE_INTEGER,
        this.droppedChars +
          (this.replayFailed ? this.storedChars - this.replayedChars : 0),
      ),
      criticalEvidenceLost: this.criticalEvidenceLost,
    };
  }

  async close(): Promise<void> {
    try {
      // Terminal delivery may resolve settlement in the middle of replay.
      // A later reroute must still invalidate that terminal before capture.
      await this.delivery;
      await this.inner.close();
      await this.delivery;
    } finally {
      this.closed = true;
      this.spool?.close();
      this.spool = null;
      if (this.spoolPath !== null) {
        Deno.removeSync(this.spoolPath);
        this.spoolPath = null;
      }
    }
  }

  isSettled(): boolean {
    return this.inner.isSettled?.() ?? true;
  }

  getFailure(): ReturnType<NonNullable<CodexSessionV1["getFailure"]>> {
    return this.inner.getFailure?.() ?? null;
  }
}
