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
import {
  parseBaseReviewOwnerArm,
  parseBaseReviewOwnerRegistration,
  parseBaseReviewOwnerSettled,
} from "../github/base-review-owner.ts";
import { parseReviewChannelNotification } from "./review-owner-channel-event.ts";
import {
  type OwnerSuccessorCustody,
  type OwnerSuccessorCustodyArm,
  type OwnerSuccessorCustodyRegistration,
  parseOwnerSuccessorCustodyArm,
  parseOwnerSuccessorCustodyRegistration,
  parseOwnerSuccessorCustodySettled,
} from "./owner-successor-acceptance-custody.ts";
import type {
  BaseReviewOwnerArmV1,
  BaseReviewOwnerCustodyV1,
  BaseReviewOwnerRegistrationV1,
} from "../github/base-review-owner.ts";

export interface ReviewOwnerChannelDescriptorV1 {
  version: "v1";
  directory: string;
  ownerRunId: string;
}

// The transport's projected envelope is at most 4 Mi UTF-16 code units. Its
// UTF-8 serialization may need three bytes per unit, plus this private wrapper.
export const REVIEW_CHANNEL_BOUND = 16 * 1024 * 1024;
const EVENT_WINDOW = 256;

/** Bound for one owner frame to become visible: a response or an event gap. */
export const REVIEW_CHANNEL_DEADLINE_MS = 20_000;
/** First rescan of a gap; a listing that missed a renamed frame heals at once. */
export const REVIEW_CHANNEL_GAP_RESCAN_MS = 5;
/** Backoff ceiling: at most two listings per second while a gap persists. */
const GAP_RESCAN_CEILING_MS = 500;
/** Skipped-frame lines one client prints; later skips are only counted. */
const MAX_SKIP_DIAGNOSTICS = 50;
/** The owner's emit() pre-increments its counter from 0 in a fresh directory. */
const FIRST_EVENT_COUNTER = 1;
const EVENT_FRAME = /^event-([0-9]{10})-[0-9a-f-]{36}\.json$/;
const RESPONSE_FRAME = /^response-[0-9a-f-]+\.json$/;

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
export class ReviewOwnerChannelClient
  implements
    ReviewOwnerCustodyV1,
    BaseReviewOwnerCustodyV1,
    OwnerSuccessorCustody {
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
  private readonly fences = new Set<{
    through: number;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly task: Promise<void>;
  private stopped = false;
  private faulted = false;
  /** Owner events dispatch strictly in counter order; later ones wait here. */
  private nextEvent = FIRST_EVENT_COUNTER;
  /** A held frame and the end of the listing that first showed it. */
  private readonly heldEvents = new Map<
    number,
    { name: string; listed: number }
  >();
  /**
   * Ascending marks: a listing that ended at `since` showed frame `above` while
   * the next counter was missing, so every counter below `above` still missing
   * has had a later frame visible since then.
   */
  private readonly holes: { above: number; since: number }[] = [];
  /**
   * Arrival of the newest frame dispatched so far: the end of the listing that
   * first showed it. A backed-up owner entry still landing its frames in
   * order keeps this moving, so its gap is not a hole. A frame a skip
   * releases counts as of its own first listing, never as of the skip.
   */
  private headArrival = Number.NEGATIVE_INFINITY;
  private previousListing = Number.NEGATIVE_INFINITY;
  private skipped = 0;
  private gapHead = 0;
  private gapDelay = REVIEW_CHANNEL_GAP_RESCAN_MS;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private scanTail: Promise<void> = Promise.resolve();
  private eventTask: Promise<void> | null = null;
  private stopEvents!: () => void;
  private readonly eventsStopped = new Promise<void>((resolve) => {
    this.stopEvents = resolve;
  });

  constructor(
    readonly descriptor: ReviewOwnerChannelDescriptorV1,
    private readonly gapDeadlineMs = REVIEW_CHANNEL_DEADLINE_MS,
  ) {
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
        this.fault();
      }
    })();
  }

  async register(input: ReviewOwnerRegistrationV1): Promise<void> {
    await this.call("register", parseReviewOwnerRegistration(input));
  }

  async settled(input: ReviewOwnerRegistrationV1): Promise<void> {
    await this.call("finalized", parseReviewOwnerRegistration(input));
  }

  async registerBaseReview(
    input: BaseReviewOwnerRegistrationV1,
  ): Promise<void> {
    await this.call(
      "registerBaseReview",
      parseBaseReviewOwnerRegistration(input),
    );
  }

  async armBaseReview(input: BaseReviewOwnerArmV1): Promise<void> {
    await this.call("armBaseReview", parseBaseReviewOwnerArm(input));
  }

  async settledBaseReview(input: { requestId: string }): Promise<void> {
    await this.call("settledBaseReview", parseBaseReviewOwnerSettled(input));
  }
  async registerOwnerSuccessor(
    input: OwnerSuccessorCustodyRegistration,
  ): Promise<void> {
    await this.call(
      "registerOwnerSuccessor",
      parseOwnerSuccessorCustodyRegistration(input),
    );
  }
  async armOwnerSuccessor(input: OwnerSuccessorCustodyArm): Promise<void> {
    await this.call("armOwnerSuccessor", parseOwnerSuccessorCustodyArm(input));
  }
  async settledOwnerSuccessor(input: { requestId: string }): Promise<void> {
    await this.call(
      "settledOwnerSuccessor",
      parseOwnerSuccessorCustodySettled(input),
    );
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
    if (this.faulted) throw new Error("review custody channel unavailable");
    const id = crypto.randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("review custody channel deadline reached"));
      }, REVIEW_CHANNEL_DEADLINE_MS);
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
    this.stopEvents();
    this.clearGapTimer();
    this.watcher.close();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("review custody channel closed"));
    }
    this.pending.clear();
    this.settleFences();
    await this.task;
    await this.scanTail;
    await this.eventTask;
  }

  /** Registration wakes disk-backed events without retaining their payloads. */
  wakeEvents(): void {
    const wake = () => this.scan().catch(() => this.fault());
    if (this.eventTask !== null) this.eventTask.finally(wake).catch(() => {});
    else void wake();
  }

  /** Close cannot settle before every event emitted by the owned process drains. */
  waitForEvents(through: unknown): Promise<void> {
    if (!Number.isSafeInteger(through) || (through as number) < 0) {
      return Promise.reject(
        new Error("review custody event fence unavailable"),
      );
    }
    if (this.stopped || this.faulted) {
      return Promise.reject(new Error("review custody channel unavailable"));
    }
    if (this.nextEvent > (through as number)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const fence = {
        through: through as number,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.fences.delete(fence);
          reject(new Error("review custody event fence deadline reached"));
        }, REVIEW_CHANNEL_DEADLINE_MS),
      };
      this.fences.add(fence);
      this.wakeEvents();
    });
  }

  private settleFences(): void {
    for (const fence of this.fences) {
      if (this.stopped || this.faulted) {
        this.fences.delete(fence);
        clearTimeout(fence.timer);
        fence.reject(new Error("review custody channel unavailable"));
      } else if (this.nextEvent > fence.through) {
        this.fences.delete(fence);
        clearTimeout(fence.timer);
        fence.resolve();
      }
    }
  }

  /** Existing unavailable path: pending calls fail and nothing more dispatches. */
  private fault(): void {
    this.faulted = true;
    this.stopEvents();
    this.clearGapTimer();
    this.settleFences();
    for (const entry of this.pending.values()) {
      entry.reject(new Error("review custody channel unavailable"));
    }
  }

  private clearGapTimer(): void {
    if (this.gapTimer !== null) clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }

  /** Watcher events and gap rescans share one serialized scan sequence. */
  private scan(): Promise<void> {
    const run = this.scanTail.then(() => this.scanOnce());
    this.scanTail = run.catch(() => {});
    return run;
  }

  /**
   * readdir is neither ordered nor atomic against concurrent renames, so one
   * listing can show frame k+1 without frame k. Events are therefore
   * dispatched only as the contiguous run from the next owner counter; a later
   * frame waits, and a consumed or skipped counter is never read again.
   */
  private async scanOnce(): Promise<void> {
    if (this.stopped || this.faulted) return;
    const directory = this.descriptor.directory;
    const listedAt = performance.now();
    const responses: string[] = [];
    let highest = 0;
    for await (const file of Deno.readDir(directory)) {
      const event = EVENT_FRAME.exec(file.name);
      if (event !== null) {
        const counter = Number(event[1]);
        if (counter < this.nextEvent) continue;
        const held = this.heldEvents.get(counter);
        if (held === undefined) {
          if (this.heldEvents.size >= EVENT_WINDOW) {
            const last = Math.max(...this.heldEvents.keys());
            if (counter > last) continue;
            this.heldEvents.delete(last);
          }
          const frame = { name: file.name, listed: Number.POSITIVE_INFINITY };
          this.heldEvents.set(counter, frame);
        } else if (held.name !== file.name) {
          throw new Error("review custody event sequence contradictory");
        }
        highest = Math.max(highest, counter);
      } else if (RESPONSE_FRAME.test(file.name)) {
        responses.push(file.name);
      }
    }
    const listedUntil = performance.now();
    for (const frame of this.heldEvents.values()) {
      if (!Number.isFinite(frame.listed)) frame.listed = listedUntil;
    }
    highest = this.heldEvents.size > 0
      ? Math.max(...this.heldEvents.keys())
      : 0;
    const last = this.holes.at(-1);
    if (
      highest >= this.nextEvent && (last === undefined || highest > last.above)
    ) {
      this.holes.push({ above: highest, since: listedUntil });
    }
    // Responses are independent from the event consumer: a callback or handler
    // registration may itself depend on initialize/thread/start returning.
    responses.sort();
    for (const name of responses) {
      let raw: Record<string, unknown>;
      try {
        raw = await readReviewChannelFile(directory + "/" + name) as Record<
          string,
          unknown
        >;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      if (typeof raw.id !== "string") continue;
      const entry = this.pending.get(raw.id);
      if (!entry) continue;
      await Deno.remove(directory + "/" + name);
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
    }
    this.skipMissingFrames(listedAt);
    this.previousListing = listedAt;
    this.startEvents();
    this.watchGap(listedAt);
  }

  private startEvents(): void {
    if (this.eventTask !== null || this.stopped || this.faulted) return;
    this.eventTask = this.dispatchEvents().catch(() => this.fault()).finally(
      () => {
        this.eventTask = null;
      },
    );
  }

  private async dispatchEvents(): Promise<void> {
    // No registered recipient: leave every payload in the private disk spool.
    if (![...this.sessions.values()].some((session) => session.ready())) return;
    let delivered = false;
    for (
      let frame = this.heldEvents.get(this.nextEvent);
      frame !== undefined;
      frame = this.heldEvents.get(this.nextEvent)
    ) {
      if (this.stopped || this.faulted) return;
      const raw = await readReviewChannelFile(
        this.descriptor.directory + "/" + frame.name,
      ) as Record<string, unknown>;
      if (typeof raw.requestId === "string") {
        const session = this.sessions.get(raw.requestId);
        if (session !== undefined) {
          if (!session.ready(raw.type)) break;
          await Promise.race([
            session.event(raw, this.nextEvent),
            this.eventsStopped,
          ]);
          if (this.stopped || this.faulted) return;
        }
      }
      this.heldEvents.delete(this.nextEvent);
      this.nextEvent++;
      this.settleFences();
      this.headArrival = Math.max(this.headArrival, frame.listed);
      while (this.holes.length > 0 && this.holes[0]!.above <= this.nextEvent) {
        this.holes.shift();
      }
      await Deno.remove(this.descriptor.directory + "/" + frame.name);
      delivered = true;
    }
    while (this.holes.length > 0 && this.holes[0]!.above <= this.nextEvent) {
      this.holes.shift();
    }
    if (delivered && !this.stopped && !this.faulted) {
      // Refill only the bounded filename window; payloads remain on disk.
      queueMicrotask(() => this.wakeEvents());
    }
  }

  /**
   * A hole's clock: when a later frame was first listed without the next
   * counter, or when the newest frame dispatched so far arrived, whichever is
   * later. emit() takes the global counter at once but writes behind its
   * entry's queue, so a healthy entry can land its frames in order long after
   * another entry's later frame is visible. Each such arrival restarts the
   * wait; only the next counter stalling for a whole deadline is a hole.
   */
  private gapClock(hole: { since: number }): number {
    return Math.max(hole.since, this.headArrival);
  }

  /**
   * The owner marks only its own entry faulted when one frame write fails (a
   * frame over the bound), so that counter never appears. Once the hole's
   * clock is a whole deadline old, and both this listing and the previous one
   * began after that deadline (so a rename racing one listing cannot be
   * mistaken for a hole), exactly the next counter is skipped: the review it
   * belonged to loses one event, as with the old client, and every other
   * review keeps its channel. A skip is not an arrival, and the frames it
   * releases arrived when first listed: those listed with the hole leave its
   * clock alone, so counters already missing under the same later frame share
   * one deadline, while frames that landed behind it (a backed-up entry above
   * a refused counter) restart the wait for the counter after them instead of
   * cascading skips through that entry. waitedMs is the skipped counter's age
   * on that clock. The line goes to stdout like the reviewer's refused-command
   * advisory: the launcher's scans ignore it there (no status key), while its
   * early-failure summary classifies the stderr prefix by substring (a
   * counter of 401 would read as unauthorized). Past the line cap, one count
   * line closes the skip run that first passed it.
   */
  private skipMissingFrames(listedAt: number): void {
    const before = this.skipped;
    for (
      let hole = this.holes[0];
      !this.stopped && this.heldEvents.size > 0 && hole !== undefined &&
      !this.heldEvents.has(this.nextEvent) && this.eventTask === null &&
      this.previousListing - this.gapClock(hole) >= this.gapDeadlineMs;
      hole = this.holes[0]
    ) {
      const clock = this.gapClock(hole);
      if (++this.skipped <= MAX_SKIP_DIAGNOSTICS) {
        console.log(JSON.stringify({
          event: "sentinel_review_channel_frame_skipped",
          counter: this.nextEvent,
          waitedMs: Math.round(listedAt - clock),
        }));
      }
      this.nextEvent++;
      this.settleFences();
      if (this.heldEvents.has(this.nextEvent)) this.startEvents();
    }
    if (before <= MAX_SKIP_DIAGNOSTICS && this.skipped > MAX_SKIP_DIAGNOSTICS) {
      console.log(JSON.stringify({
        event: "sentinel_review_channel_frame_skip_lines_capped",
        skipped: this.skipped,
      }));
    }
  }

  /**
   * A held frame without the next one is a gap. No further watcher event may
   * come (it can be the run's final frame), so the client rescans itself with
   * a bounded backoff that restarts on progress, lands its first listing on
   * the hole's deadline and confirms it with one more. Nothing held means no
   * rescan: a missing frame with nothing after it waits for the watcher.
   */
  private watchGap(listedAt: number): void {
    if (this.stopped || this.faulted) return;
    const hole = this.holes[0];
    if (
      this.heldEvents.size === 0 || hole === undefined ||
      this.heldEvents.has(this.nextEvent)
    ) {
      this.gapHead = 0;
      this.clearGapTimer();
      return;
    }
    if (this.gapHead !== this.nextEvent) {
      this.clearGapTimer();
      this.gapHead = this.nextEvent;
      this.gapDelay = REVIEW_CHANNEL_GAP_RESCAN_MS;
    }
    if (this.gapTimer !== null) return;
    const due = this.gapClock(hole) + this.gapDeadlineMs - listedAt;
    const delay = due > 0
      ? Math.min(this.gapDelay, due)
      : REVIEW_CHANNEL_GAP_RESCAN_MS;
    this.gapDelay = Math.min(this.gapDelay * 2, GAP_RESCAN_CEILING_MS);
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      this.scan().catch(() => this.fault());
    }, delay);
  }
}

class BrokeredReviewSession implements CodexSessionV1 {
  private opened: Promise<unknown> | null = null;
  private notification:
    | ((event: CodexServerNotificationV1) => void | Promise<void>)
    | null = null;
  private serverRequest:
    | ((event: CodexServerRequestV1) => void | Promise<void>)
    | null = null;
  private closed = false;
  private lastObservedEvent = 0;
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
  onNotification(
    handler: (event: CodexServerNotificationV1) => void | Promise<void>,
  ): void {
    this.notification = handler;
    this.client.wakeEvents();
  }
  onServerRequest(
    handler: (event: CodexServerRequestV1) => void | Promise<void>,
  ): void {
    this.serverRequest = handler;
    this.client.wakeEvents();
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      this.client.wakeEvents();
      if (this.opened === null) {
        this.settled = true;
        return;
      }
      await this.opened;
      const result = await this.client.call("close", {
        requestId: this.identity.requestId,
      }) as { settled?: unknown; eventThrough?: unknown; faulted?: unknown };
      this.settled = result.settled === true;
      if (result.faulted !== false) {
        throw new Error("review custody owner evidence unavailable");
      }
      if (
        !Number.isSafeInteger(result.eventThrough) ||
        (result.eventThrough as number) < this.lastObservedEvent
      ) throw new Error("review custody event fence moved backward");
      await this.client.waitForEvents(result.eventThrough);
      if (!this.settled) {
        throw new Error("review custody session remains unsettled");
      }
    })();
    return this.closePromise;
  }
  isSettled(): boolean {
    return this.settled;
  }
  ready(type?: unknown): boolean {
    if (this.closed) return true;
    return type === "notification"
      ? this.notification !== null
      : type === "serverRequest"
      ? this.serverRequest !== null
      : this.notification !== null || this.serverRequest !== null;
  }
  async event(raw: Record<string, unknown>, counter: number): Promise<void> {
    this.lastObservedEvent = counter;
    if (raw.type === "notification") {
      await this.notification?.(parseReviewChannelNotification(raw.event));
    } else if (raw.type === "serverRequest") {
      await this.serverRequest?.(raw.event as CodexServerRequestV1);
    } else throw new Error("review custody event type unavailable");
  }
}
