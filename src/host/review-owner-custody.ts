/** Surviving trusted launcher owns reviewer spawn handles, never child PIDs. */
import { canonicalStringify } from "../contracts/canonical.ts";
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
  readReviewChannelFile,
  writeReviewChannelFile,
} from "./review-owner-channel.ts";
import type { ReviewOwnerChannelDescriptorV1 } from "./review-owner-channel.ts";

export interface LauncherReviewSessionTargetV1 {
  repository: RepositoryIdentityV1;
  session: CodexTransportOptionsV1;
  provider: string;
  model: string;
  permissionProfile: string;
}

interface OwnedBrokerReview {
  registration: ReviewOwnerRegistrationV1;
  target: LauncherReviewSessionTargetV1;
  session: CodexSessionV1 | null;
  prepared: ReviewJournalExecutionV1 | null;
  invocationId: string | null;
  turnStarted: boolean;
  processSettled: boolean;
  finalized: boolean;
  faulted: boolean;
  eventTail: Promise<void>;
}

export class ReviewOwnerCustodyBroker {
  readonly execution: HostedExecutionIntentV1;
  private readonly entries = new Map<string, OwnedBrokerReview>();
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
    await Promise.allSettled([...this.tasks]);
    const records: HostedReviewOwnerSettlementV1[] = [];
    if (publisher.settled && !publisher.truncated) {
      for (const entry of this.entries.values()) {
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
      const task = this.handle(file.name).finally(() =>
        this.tasks.delete(task)
      );
      this.tasks.add(task);
    }
  }

  private async handle(file: string): Promise<void> {
    const id = file.slice(8, -5);
    try {
      const request = await readReviewChannelFile(
        this.descriptor().directory + "/" + file,
      ) as Record<string, unknown>;
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
    } catch {
      await writeReviewChannelFile(
        this.descriptor().directory + "/response-" + id + ".json",
        { id, error: true },
      ).catch(() => {});
    }
  }

  private async dispatch(method: string, value: unknown): Promise<unknown> {
    if (this.stopping) throw new Error("review custody stopped");
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
    const keys = method === "open"
      ? "cwd,invocationId,ownerRunId,requestId"
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
        typeof params.invocationId !== "string"
      ) {
        entry.faulted = true;
        throw new Error("review custody session identity changed");
      }
      entry.invocationId = params.invocationId;
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
      return { settled: entry.processSettled };
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
      !["initialize", "thread/start", "turn/start"].includes(params.method)
    ) throw new Error("review custody method refused");
    const input = params.params as Record<string, unknown>;
    if (
      params.method === "thread/start" &&
      (input.cwd !== entry.target.session.cwd ||
        input.model !== entry.target.model ||
        input.modelProvider !== entry.target.provider ||
        input.permissions !== entry.target.permissionProfile)
    ) throw new Error("review custody thread policy changed");
    if (params.method === "turn/start") {
      if (
        entry.turnStarted || entry.registration.journal.phase !== "running" ||
        input.threadId !== entry.prepared?.threadId ||
        input.model !== entry.target.model ||
        input.permissions !== entry.target.permissionProfile ||
        input.effort !== "max"
      ) throw new Error("review custody turn identity unavailable");
      entry.turnStarted = true;
    }
    const response = await session.send(params.method, params.params);
    if (params.method === "thread/start") {
      const result = response as Record<string, unknown>;
      const thread = result.thread as Record<string, unknown>;
      if (
        !thread || typeof thread.id !== "string" ||
        result.model !== entry.target.model ||
        result.modelProvider !== entry.target.provider ||
        result.reasoningEffort !== "max"
      ) {
        entry.faulted = true;
        throw new Error("review custody preparation unproved");
      }
      entry.prepared = {
        ownerRunId: this.execution.id,
        invocationId: entry.invocationId!,
        threadId: thread.id,
        submittedProvider: entry.target.provider,
        model: entry.target.model,
        reasoning: "max",
        startMayOccur: true,
      };
    }
    return response;
  }

  private emit(entry: OwnedBrokerReview, type: string, event: unknown): void {
    this.eventCount++;
    const name = "event-" + String(this.eventCount).padStart(10, "0") + "-" +
      crypto.randomUUID() + ".json";
    const task = entry.eventTail.then(() =>
      writeReviewChannelFile(this.descriptor().directory + "/" + name, {
        requestId: entry.registration.journal.requestId,
        type,
        event,
      })
    ).catch(() => {
      entry.faulted = true;
    }).finally(() => this.tasks.delete(task));
    entry.eventTail = task;
    this.tasks.add(task);
  }

  private async closeEntry(entry: OwnedBrokerReview): Promise<void> {
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
