/** Surviving trusted launcher owns reviewer spawn handles, never child PIDs. */
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import { parseHostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { CodexSubprocessSession } from "../repair/codex-transport.ts";
import type {
  CodexSessionV1,
  CodexTransportOptionsV1,
} from "../repair/codex-transport.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../replay/runtime.ts";
import {
  parseReviewOwnerRegistration,
  parseReviewOwnerSettlementCarrier,
} from "../github/review-owner-evidence.ts";
import type {
  HostedReviewOwnerSettlementV1,
  ReviewOwnerRegistrationV1,
} from "../github/review-owner-evidence.ts";
import type { ReviewJournalExecutionV1 } from "../github/journal-metadata.ts";
import {
  parseBaseReviewOwnerArm,
  parseBaseReviewOwnerRegistration,
  parseBaseReviewOwnerSettled,
} from "../github/base-review-owner.ts";
import type { BaseReviewOwnerRegistrationV1 } from "../github/base-review-owner.ts";
import {
  readReviewChannelFile,
  writeReviewChannelFile,
} from "./review-owner-channel.ts";
import type { ReviewOwnerChannelDescriptorV1 } from "./review-owner-channel.ts";
import {
  type OwnerSuccessorCustodyRegistration,
  parseOwnerSuccessorCustodyArm,
  parseOwnerSuccessorCustodyRegistration,
  parseOwnerSuccessorCustodySettled,
} from "./owner-successor-acceptance-custody.ts";

export interface LauncherReviewSessionTargetV1 {
  repository: RepositoryIdentityV1;
  session: CodexTransportOptionsV1;
  provider?: string;
  model?: string;
  permissionProfile: string;
}

interface OwnedBrokerSession {
  nativeReviewTargetDigest?: string;
  target: LauncherReviewSessionTargetV1;
  session: CodexSessionV1 | null;
  prepared: ReviewJournalExecutionV1 | null;
  invocationId: string | null;
  turnStarted: boolean;
  processSettled: boolean;
  finalized: boolean;
  faulted: boolean;
  eventTail: Promise<void>;
  lastEventCounter: number;
}

interface OwnedBrokerReview extends OwnedBrokerSession {
  kind: "pull_request";
  registration: ReviewOwnerRegistrationV1;
}

interface OwnedBrokerBaseReview extends OwnedBrokerSession {
  kind: "base";
  registration: BaseReviewOwnerRegistrationV1;
  preparationStarted: boolean;
  armed: boolean;
}

interface OwnedBrokerSuccessorReview
  extends Omit<OwnedBrokerBaseReview, "kind" | "registration"> {
  kind: "owner_successor";
  registration: OwnerSuccessorCustodyRegistration;
}
type OwnedBrokerEntry =
  | OwnedBrokerReview
  | OwnedBrokerBaseReview
  | OwnedBrokerSuccessorReview;

export class ReviewOwnerCustodyBroker {
  readonly execution: HostedExecutionIntentV1;
  private readonly entries = new Map<string, OwnedBrokerEntry>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly seen = new Set<string>();
  private watcher: Deno.FsWatcher | null = null;
  private server: Promise<void> | null = null;
  private descriptorValue: ReviewOwnerChannelDescriptorV1 | null = null;
  private stopping = false;
  private eventCount = 0;

  constructor(
    execution: HostedExecutionIntentV1,
    private readonly targets: readonly LauncherReviewSessionTargetV1[],
  ) {
    this.execution = parseHostedExecutionIntentV1(execution);
    if (this.execution.purpose !== "ordinary" || targets.length === 0) {
      throw new Error("review custody owner unavailable");
    }
    this.targets = targets.map((target) => ({
      ...target,
      repository: { ...target.repository },
      session: {
        ...target.session,
        command: [...target.session.command],
        env: { ...target.session.env },
      },
    }));
  }

  async start(
    parentDirectory: string,
  ): Promise<ReviewOwnerChannelDescriptorV1> {
    if (this.descriptorValue !== null) {
      throw new Error("review custody already started");
    }
    const directory = await Deno.makeTempDir({
      dir: parentDirectory,
      prefix: "review-custody-",
    });
    await Deno.chmod(directory, 0o700);
    this.descriptorValue = {
      version: "v1",
      directory,
      ownerRunId: this.execution.id,
    };
    this.watcher = Deno.watchFs(directory, { recursive: false });
    this.server = (async () => {
      try {
        await this.scan();
        for await (const _event of this.watcher!) await this.scan();
      } catch {
        if (!this.stopping) {
          for (const entry of this.entries.values()) entry.faulted = true;
        }
      }
    })();
    return this.descriptorValue;
  }

  descriptor(): ReviewOwnerChannelDescriptorV1 {
    if (this.descriptorValue === null) {
      throw new Error("review custody not started");
    }
    return this.descriptorValue;
  }

  /** Called only by the launcher after its actual publisher process border returns. */
  async finish(
    publisher: Pick<ReplayCommandResultV1, "settled" | "truncated">,
  ): Promise<HostedReviewOwnerSettlementV1[]> {
    this.stopping = true;
    this.watcher?.close();
    await this.server;
    for (const entry of this.entries.values()) await this.closeEntry(entry);
    await Promise.allSettled(
      [...this.entries.values()].map((entry) => entry.eventTail),
    );
    await Promise.allSettled([...this.tasks]);
    const records: HostedReviewOwnerSettlementV1[] = [];
    if (publisher.settled && !publisher.truncated) {
      for (const entry of this.entries.values()) {
        // Base-review custody is ephemeral. Never emit a carrier R80 cannot parse;
        // an interrupted base review retains its original charged reservation.
        if (entry.kind !== "pull_request") continue;
        // The publisher and all broker-owned RPC work are dead/settled; no journal finalization can continue.
        if (!entry.processSettled || entry.session !== null || entry.faulted) {
          continue;
        }
        const carrier = parseReviewOwnerSettlementCarrier({
          ...entry.registration,
          version: "v1",
          kind: "review_owner_settled",
          ownerExecution: this.execution,
          preparedExecution: entry.prepared,
          settledAt: Date.now(),
          submissionSettled: true,
          finalizationSettled: true,
          processSettled: true,
          noRetainedHandle: true,
        });
        records.push({
          version: "v1",
          kind: "hosted_review_owner_settled",
          execution: this.execution,
          carrier,
        });
      }
    }
    return records;
  }

  async dispose(): Promise<void> {
    if (!this.stopping) await this.finish({ settled: false, truncated: false });
    if (
      this.descriptorValue !== null &&
      [...this.entries.values()].every((entry) => entry.processSettled)
    ) {
      await Deno.remove(this.descriptorValue.directory, { recursive: true });
    }
  }

  private async scan(): Promise<void> {
    for await (const file of Deno.readDir(this.descriptor().directory)) {
      if (
        !/^request-[0-9a-f-]{36}\.json$/.test(file.name) ||
        this.seen.has(file.name)
      ) continue;
      this.seen.add(file.name);
      const task = this.handle(file.name).finally(async () => {
        await Deno.remove(this.descriptor().directory + "/" + file.name)
          .catch(() => {});
        this.seen.delete(file.name);
        this.tasks.delete(task);
      });
      this.tasks.add(task);
    }
  }

  private async handle(file: string): Promise<void> {
    const id = file.slice(8, -5);
    let requestRead = false;
    try {
      const request = await readReviewChannelFile(
        this.descriptor().directory + "/" + file,
      ) as Record<string, unknown>;
      requestRead = true;
      if (
        request.id !== id ||
        Object.keys(request).sort().join(",") !== "id,method,params" ||
        typeof request.method !== "string"
      ) throw new Error("review custody request malformed");
      const result = await this.dispatch(request.method, request.params);
      await writeReviewChannelFile(
        this.descriptor().directory + "/response-" + id + ".json",
        { id, result },
      );
    } catch (error) {
      // A non-atomic listing may still yield a request removed by its completed
      // handler. It must not overwrite that handler's response with an error.
      if (!requestRead && error instanceof Deno.errors.NotFound) return;
      await writeReviewChannelFile(
        this.descriptor().directory + "/response-" + id + ".json",
        { id, error: true },
      ).catch(() => {});
    }
  }

  private async dispatch(method: string, value: unknown): Promise<unknown> {
    if (this.stopping) throw new Error("review custody stopped");
    if (
      ["registerOwnerSuccessor", "armOwnerSuccessor", "settledOwnerSuccessor"]
        .includes(method)
    ) return this.dispatchOwnerSuccessor(method, value);
    if (
      method === "registerBaseReview" || method === "armBaseReview" ||
      method === "settledBaseReview"
    ) return this.dispatchBaseReview(method, value);
    if (method === "register" || method === "finalized") {
      const registration = parseReviewOwnerRegistration(value);
      if (
        canonicalStringify(registration.journal.ownerExecution) !==
          canonicalStringify(this.execution)
      ) throw new Error("review custody foreign owner");
      const target = this.targets.find((item) =>
        canonicalStringify(item.repository) ===
          canonicalStringify(registration.repository)
      );
      if (!target) throw new Error("review custody foreign repository");
      const key = registration.journal.requestId;
      const prior = this.entries.get(key);
      if (prior) {
        if (prior.kind !== "pull_request") {
          throw new Error("review custody operation kind changed");
        }
        const original = prior.registration;
        const a: Record<string, unknown> = { ...original.journal };
        const b: Record<string, unknown> = { ...registration.journal };
        for (const key of ["phase", "reviewId", "execution"]) {
          delete a[key];
          delete b[key];
        }
        if (
          original.reviewId !== registration.reviewId ||
          canonicalStringify(a) !== canonicalStringify(b)
        ) throw new Error("review custody changed operation");
        if (
          registration.journal.phase === "running" &&
          canonicalStringify(registration.journal.execution) !==
            canonicalStringify(prior.prepared)
        ) throw new Error("review custody changed prepared identity");
        prior.registration = registration;
        if (method === "finalized") {
          if (!prior.processSettled || prior.session !== null) {
            throw new Error("review custody unproved close");
          }
          prior.finalized = true;
        }
      } else {
        if (method !== "register" || registration.journal.phase !== "intent") {
          throw new Error("review custody registration unavailable");
        }
        this.entries.set(key, {
          kind: "pull_request",
          registration,
          target,
          session: null,
          prepared: null,
          invocationId: null,
          turnStarted: false,
          processSettled: true,
          finalized: false,
          faulted: false,
          eventTail: Promise.resolve(),
          lastEventCounter: 0,
        });
      }
      return null;
    }
    const params = value as Record<string, unknown>;
    if (!params || typeof params.requestId !== "string") {
      throw new Error("review custody request identity unavailable");
    }
    const entry = this.entries.get(params.requestId);
    if (!entry) throw new Error("review custody operation unregistered");
    if (entry.kind !== "pull_request" && (entry.faulted || entry.finalized)) {
      throw new Error("base review custody operation unavailable");
    }
    const keys = method === "open"
      ? "cwd,invocationId,nativeReviewTargetDigest,ownerRunId,requestId"
      : method === "close"
      ? "requestId"
      : "method,params,requestId";
    if (Object.keys(params).sort().join(",") !== keys) {
      entry.faulted = true;
      throw new Error("review custody uncontrolled session request");
    }
    if (method === "open") {
      if (
        entry.session !== null || entry.prepared !== null ||
        params.ownerRunId !== this.execution.id ||
        params.cwd !== entry.target.session.cwd ||
        typeof params.invocationId !== "string" ||
        typeof params.nativeReviewTargetDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(params.nativeReviewTargetDigest) ||
        (entry.kind !== "pull_request" && entry.invocationId !== null) ||
        (entry.kind === "owner_successor" &&
          params.invocationId !==
            entry.registration.review.binding.invocationId)
      ) {
        entry.faulted = true;
        throw new Error("review custody session identity changed");
      }
      entry.invocationId = params.invocationId;
      entry.nativeReviewTargetDigest = params
        .nativeReviewTargetDigest as string;
      const session = new CodexSubprocessSession(entry.target.session);
      entry.session = session;
      entry.processSettled = false;
      session.onNotification((event) =>
        this.emit(entry, "notification", event)
      );
      session.onServerRequest((event) =>
        this.emit(entry, "serverRequest", event)
      );
      session.open();
      return null;
    }
    if (method === "close") {
      await this.closeEntry(entry);
      await entry.eventTail;
      return {
        settled: entry.processSettled,
        eventThrough: entry.lastEventCounter,
        faulted: entry.faulted,
      };
    }
    const session = entry.session;
    if (session === null || typeof params.method !== "string") {
      throw new Error("review custody session unavailable");
    }
    if (method === "notify") {
      if (params.method !== "initialized") {
        throw new Error("review custody notification refused");
      }
      session.notify(params.method, params.params);
      return null;
    }
    if (
      method !== "send" ||
      !["initialize", "thread/start", "review/start"].includes(params.method)
    ) throw new Error("review custody method refused");
    const input = params.params as Record<string, unknown>;
    if (
      params.method === "thread/start" &&
      (input.cwd !== entry.target.session.cwd ||
        ["model", "modelProvider", "effort", "outputSchema"].some((key) =>
          Object.hasOwn(input, key)
        ) ||
        (typeof input.config === "object" && input.config !== null &&
          ["model", "model_provider", "model_reasoning_effort", "review_model"]
            .some((key) => Object.hasOwn(input.config!, key))) ||
        input.permissions !== entry.target.permissionProfile)
    ) throw new Error("review custody thread policy changed");
    if (entry.kind !== "pull_request" && params.method === "thread/start") {
      if (entry.preparationStarted) {
        throw new Error("base review custody already prepared");
      }
      entry.preparationStarted = true;
    }
    if (params.method === "review/start") {
      if (
        entry.turnStarted ||
        (entry.kind !== "pull_request"
          ? !entry.armed
          : entry.registration.journal.phase !== "running") ||
        input.threadId !== entry.prepared?.threadId ||
        input.delivery !== "inline" ||
        Object.keys(input).sort().join(",") !== "delivery,target,threadId"
      ) throw new Error("review custody turn identity unavailable");
      entry.turnStarted = true;
      const target = input.target as Record<string, unknown>;
      if (
        !target || target.type !== "custom" ||
        typeof target.instructions !== "string" ||
        Object.keys(target).sort().join(",") !== "instructions,type" ||
        await canonicalStringifySha256(target) !==
          entry.nativeReviewTargetDigest
      ) {
        entry.faulted = true;
        throw new Error("review custody native target changed");
      }
    }
    const response = await session.send(params.method, params.params);
    if (params.method === "thread/start") {
      const result = response as Record<string, unknown>;
      const thread = result.thread as Record<string, unknown>;
      if (
        !thread || typeof thread.id !== "string" ||
        typeof result.modelProvider !== "string" || !result.modelProvider
      ) {
        entry.faulted = true;
        throw new Error("review custody preparation unproved");
      }
      entry.prepared = {
        ownerRunId: this.execution.id,
        invocationId: entry.invocationId!,
        threadId: thread.id,
        submittedProvider: result.modelProvider,
        model: null,
        reasoning: null,
        nativeReview: {
          mode: "review/start",
          targetDigest: entry.nativeReviewTargetDigest!,
        },
        startMayOccur: true,
      };
    }
    return response;
  }

  private dispatchBaseReview(method: string, value: unknown): null {
    if (method === "registerBaseReview") {
      const registration = parseBaseReviewOwnerRegistration(value);
      if (registration.ownerRunId !== this.execution.id) {
        throw new Error("base review custody foreign owner");
      }
      const target = this.targets.find((item) =>
        canonicalStringify(item.repository) ===
          canonicalStringify(registration.repository)
      );
      if (!target) throw new Error("base review custody foreign repository");
      const prior = this.entries.get(registration.requestId);
      if (prior) {
        if (
          prior.kind !== "base" ||
          canonicalStringify(prior.registration) !==
            canonicalStringify(registration)
        ) throw new Error("base review custody changed operation");
      } else {
        this.entries.set(registration.requestId, {
          kind: "base",
          registration,
          target,
          session: null,
          prepared: null,
          invocationId: null,
          turnStarted: false,
          preparationStarted: false,
          armed: false,
          processSettled: true,
          finalized: false,
          faulted: false,
          eventTail: Promise.resolve(),
          lastEventCounter: 0,
        });
      }
      return null;
    }
    const input = method === "armBaseReview"
      ? parseBaseReviewOwnerArm(value)
      : parseBaseReviewOwnerSettled(value);
    const entry = this.entries.get(input.requestId);
    if (!entry || entry.kind !== "base" || entry.faulted) {
      throw new Error("base review custody registration unavailable");
    }
    if ("execution" in input) {
      if (
        entry.armed || entry.finalized || entry.turnStarted ||
        entry.session === null || entry.processSettled ||
        entry.prepared === null ||
        canonicalStringify(input.execution) !==
          canonicalStringify(entry.prepared)
      ) throw new Error("base review custody prepared identity unavailable");
      // Only the trusted publisher calls this after its durable running
      // reservation write and exact readback. The broker owns no state writer.
      entry.armed = true;
    } else {
      if (!entry.processSettled || entry.session !== null) {
        throw new Error("base review custody unproved close");
      }
      entry.finalized = true;
    }
    return null;
  }

  private dispatchOwnerSuccessor(method: string, value: unknown): null {
    if (method === "registerOwnerSuccessor") {
      const registration = parseOwnerSuccessorCustodyRegistration(value),
        review = registration.review;
      if (
        canonicalStringify(review.binding.nativeOwner) !==
          canonicalStringify(this.execution)
      ) throw new Error("owner successor custody foreign native owner");
      const target = this.targets.find((item) =>
        canonicalStringify(item.repository) ===
          canonicalStringify(review.reservation.repository)
      );
      if (!target) {
        throw new Error("owner successor custody foreign repository");
      }
      const key = review.binding.requestId, prior = this.entries.get(key);
      if (prior) {
        if (
          prior.kind !== "owner_successor" ||
          canonicalStringify(prior.registration) !==
            canonicalStringify(registration)
        ) throw new Error("owner successor custody changed operation");
      } else {this.entries.set(key, {
          kind: "owner_successor",
          registration,
          target,
          session: null,
          prepared: null,
          invocationId: null,
          turnStarted: false,
          preparationStarted: false,
          armed: false,
          processSettled: true,
          finalized: false,
          faulted: false,
          eventTail: Promise.resolve(),
          lastEventCounter: 0,
        });}
      return null;
    }
    const input = method === "armOwnerSuccessor"
      ? parseOwnerSuccessorCustodyArm(value)
      : parseOwnerSuccessorCustodySettled(value);
    const entry = this.entries.get(input.requestId);
    if (!entry || entry.kind !== "owner_successor" || entry.faulted) {
      throw new Error("owner successor custody registration unavailable");
    }
    if ("execution" in input) {
      if (
        entry.armed || entry.finalized || entry.turnStarted ||
        entry.session === null || entry.processSettled ||
        entry.prepared === null ||
        canonicalStringify(input.execution) !==
          canonicalStringify(entry.prepared)
      ) {
        throw new Error(
          "owner successor custody prepared identity unavailable",
        );
      }
      entry.armed = true;
    } else {
      if (!entry.processSettled || entry.session !== null) {
        throw new Error("owner successor custody unproved close");
      }
      entry.finalized = true;
    }
    return null;
  }

  private async emit(
    entry: OwnedBrokerEntry,
    type: string,
    event: unknown,
  ): Promise<void> {
    this.eventCount++;
    entry.lastEventCounter = this.eventCount;
    const name = "event-" + String(this.eventCount).padStart(10, "0") + "-" +
      crypto.randomUUID() + ".json";
    // The transport awaits each consumer before reading the next frame. One
    // owned write is retained per session; never queue payload-capturing promises.
    const task = writeReviewChannelFile(
      this.descriptor().directory + "/" + name,
      {
        requestId: entry.kind === "base"
          ? entry.registration.requestId
          : entry.kind === "owner_successor"
          ? entry.registration.review.binding.requestId
          : entry.registration.journal.requestId,
        type,
        event,
      },
    ).catch(() => {
      entry.faulted = true;
    });
    entry.eventTail = task;
    await task;
  }

  private async closeEntry(entry: OwnedBrokerEntry): Promise<void> {
    const session = entry.session;
    if (session === null) return;
    try {
      await session.close();
      entry.processSettled = session.isSettled?.() === true;
      if (
        session.getFailure?.() !== null && session.getFailure?.() !== undefined
      ) entry.faulted = true;
    } catch {
      entry.processSettled = false;
    }
    if (entry.processSettled) entry.session = null;
  }
}

/** Production process border: the parent survives and settles every actual reviewer handle. */
export async function runRepairOwnerWithReviewCustody(
  broker: ReviewOwnerCustodyBroker,
  process: ReplayRuntimeV1,
  input: ReplayCommandInputV1,
): Promise<
  { run: ReplayCommandResultV1; settlements: HostedReviewOwnerSettlementV1[] }
> {
  let run: ReplayCommandResultV1;
  try {
    run = await process.run(input);
  } catch (error) {
    await broker.finish({ settled: false, truncated: false });
    throw error;
  }
  const settlements = await broker.finish(run);
  return { run, settlements };
}
