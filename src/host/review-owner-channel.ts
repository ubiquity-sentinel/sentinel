/** Private file IPC. Descriptors cross only to the trusted repair publisher. */
import { CodexProtocolError } from "../repair/codex-transport.ts";
import type {
  CodexServerNotificationV1,
  CodexServerRequestV1,
  CodexSessionV1,
} from "../repair/codex-transport.ts";
import { parseReviewOwnerRegistration } from "../github/review-owner-evidence.ts";
import type {
  ReviewOwnerCustodyV1,
  ReviewOwnerRegistrationV1,
} from "../github/review-owner-evidence.ts";

export interface ReviewOwnerChannelDescriptorV1 {
  version: "v1";
  directory: string;
  ownerRunId: string;
}

export const REVIEW_CHANNEL_BOUND = 4 * 1024 * 1024;

export async function writeReviewChannelFile(
  path: string,
  value: unknown,
): Promise<void> {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > REVIEW_CHANNEL_BOUND) {
    throw new Error("review custody frame exceeds bound");
  }
  const staging = path + "." + crypto.randomUUID() + ".tmp";
  await Deno.writeTextFile(staging, text, { mode: 0o600, createNew: true });
  await Deno.rename(staging, path);
}

export async function readReviewChannelFile(path: string): Promise<unknown> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size > REVIEW_CHANNEL_BOUND) {
    throw new Error("review custody frame unavailable");
  }
  return JSON.parse(await Deno.readTextFile(path));
}

/** One bounded RPC client; no executable, PID, credentials or model route is sent. */
export class ReviewOwnerChannelClient implements ReviewOwnerCustodyV1 {
  private readonly watcher: Deno.FsWatcher;
  private readonly pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly sessions = new Map<string, BrokeredReviewSession>();
  private readonly seen = new Set<string>();
  private readonly task: Promise<void>;
  private stopped = false;

  constructor(readonly descriptor: ReviewOwnerChannelDescriptorV1) {
    if (
      descriptor.version !== "v1" || !descriptor.directory.startsWith("/") ||
      descriptor.ownerRunId.length === 0
    ) throw new Error("review custody descriptor invalid");
    const watcher = Deno.watchFs(descriptor.directory, { recursive: false });
    this.watcher = watcher;
    this.task = (async () => {
      try {
        await this.scan();
        for await (const _event of watcher) await this.scan();
      } catch {
        for (const entry of this.pending.values()) {
          entry.reject(new Error("review custody channel unavailable"));
        }
      }
    })();
  }

  async register(input: ReviewOwnerRegistrationV1): Promise<void> {
    await this.call("register", parseReviewOwnerRegistration(input));
  }

  async settled(input: ReviewOwnerRegistrationV1): Promise<void> {
    await this.call("finalized", parseReviewOwnerRegistration(input));
  }

  openSession(
    input: {
      cwd: string;
      requestId?: string;
      invocationId?: string;
      ownerRunId?: string;
    },
  ): CodexSessionV1 {
    if (
      !input.requestId || !input.invocationId ||
      input.ownerRunId !== this.descriptor.ownerRunId
    ) throw new Error("review custody session identity unavailable");
    if (this.sessions.has(input.requestId)) {
      throw new Error("review custody session already owned");
    }
    const session = new BrokeredReviewSession(
      this,
      input as Required<typeof input>,
    );
    this.sessions.set(input.requestId, session);
    return session;
  }

  async call(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) throw new Error("review custody channel closed");
    const id = crypto.randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("review custody channel deadline reached"));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await writeReviewChannelFile(
        this.descriptor.directory + "/request-" + id + ".json",
        { id, method, params },
      );
    } catch (error) {
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new Error("review custody channel write failed"));
      }
      await result.catch(() => {});
      throw error;
    }
    return await result;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.watcher.close();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("review custody channel closed"));
    }
    this.pending.clear();
    await this.task;
  }

  private async scan(): Promise<void> {
    const files = [];
    for await (const file of Deno.readDir(this.descriptor.directory)) {
      files.push(file);
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    for (const file of files) {
      if (
        !/^(response|event)-[0-9a-f-]+\.json$/.test(file.name) ||
        this.seen.has(file.name)
      ) continue;
      this.seen.add(file.name);
      const raw = await readReviewChannelFile(
        this.descriptor.directory + "/" + file.name,
      ) as Record<string, unknown>;
      if (file.name.startsWith("response-") && typeof raw.id === "string") {
        const entry = this.pending.get(raw.id);
        if (!entry) continue;
        this.pending.delete(raw.id);
        clearTimeout(entry.timer);
        if (raw.error === true) {
          entry.reject(
            new CodexProtocolError(
              "server_error",
              "review custody request refused",
            ),
          );
        } else entry.resolve(raw.result);
      } else if (typeof raw.requestId === "string") {
        this.sessions.get(raw.requestId)?.event(raw);
      }
    }
  }
}

class BrokeredReviewSession implements CodexSessionV1 {
  private opened: Promise<unknown> | null = null;
  private notification: ((event: CodexServerNotificationV1) => void) | null =
    null;
  private serverRequest: ((event: CodexServerRequestV1) => void) | null = null;
  private readonly backlog: Record<string, unknown>[] = [];
  private settled = false;
  private closePromise: Promise<void> | null = null;
  private notificationTail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly client: ReviewOwnerChannelClient,
    private readonly identity: {
      cwd: string;
      requestId: string;
      invocationId: string;
      ownerRunId: string;
    },
  ) {}
  open(): void {
    this.opened ??= this.client.call("open", this.identity);
    this.opened.catch(() => {});
  }
  async send(method: string, params: unknown): Promise<unknown> {
    this.open();
    await this.opened;
    await this.notificationTail;
    return await this.client.call("send", {
      requestId: this.identity.requestId,
      method,
      params,
    });
  }
  notify(method: string, params?: unknown): void {
    this.open();
    this.notificationTail = this.opened!.then(() =>
      this.client.call("notify", {
        requestId: this.identity.requestId,
        method,
        params: params ?? null,
      })
    );
    this.notificationTail.catch(() => {});
  }
  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notification = handler;
    this.flush();
  }
  onServerRequest(handler: (event: CodexServerRequestV1) => void): void {
    this.serverRequest = handler;
    this.flush();
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      if (this.opened === null) {
        this.settled = true;
        return;
      }
      await this.opened;
      const result = await this.client.call("close", {
        requestId: this.identity.requestId,
      }) as { settled?: unknown };
      this.settled = result.settled === true;
      if (!this.settled) {
        throw new Error("review custody session remains unsettled");
      }
    })();
    return this.closePromise;
  }
  isSettled(): boolean {
    return this.settled;
  }
  event(raw: Record<string, unknown>): void {
    this.backlog.push(raw);
    this.flush();
  }
  private flush(): void {
    while (this.backlog.length > 0) {
      const event = this.backlog[0]!;
      if (event.type === "notification") {
        if (this.notification === null) return;
        this.backlog.shift();
        this.notification(event.event as CodexServerNotificationV1);
      } else {
        if (this.serverRequest === null) return;
        this.backlog.shift();
        this.serverRequest(event.event as CodexServerRequestV1);
      }
    }
  }
}
