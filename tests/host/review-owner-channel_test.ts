/** The custody client must deliver owner events in counter order, whatever readdir lists. */
import assert from "node:assert/strict";
import {
  REVIEW_CHANNEL_BOUND,
  ReviewOwnerChannelClient,
  writeReviewChannelFile,
} from "../../src/host/review-owner-channel.ts";
import { ReviewOwnerCustodyBroker } from "../../src/host/review-owner-custody.ts";
import { reviewOwnerRegistration } from "../../src/github/review-owner-evidence.ts";
import { renderReviewJournalBody } from "../../src/github/review-journal.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { CodexServerNotificationV1 } from "../../src/repair/codex-transport.ts";
import { CodexStructuredReviewer } from "../../src/github/codex-reviewer.ts";
import {
  CLEAN_RESULT,
  commandItem,
  prepareRequest,
  PROVIDER,
  REVIEW_PROFILE,
  SESSION_CWD,
  snapshotFixture,
  turnCompleted,
} from "../github/codex-reviewer-helpers.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const OWNER_RUN = "run-1";
const realReadDir = Deno.readDir;

/** Exactly the owner's emit() frame name: global 10-digit counter plus a uuid. */
function frameName(counter: number): string {
  return "event-" + String(counter).padStart(10, "0") + "-" +
    crypto.randomUUID() + ".json";
}

/** Counter of a renamed frame; a staging `.tmp` name is not a frame yet. */
function counterOf(name: string): number | null {
  const match = /^event-([0-9]{10})-[0-9a-f-]{36}\.json$/.exec(name);
  return match === null ? null : Number(match[1]);
}

function writeEvent(
  directory: string,
  counter: number,
  requestId: string,
  method: string,
  params: unknown,
): Promise<void> {
  return writeReviewChannelFile(directory + "/" + frameName(counter), {
    requestId,
    type: "notification",
    event: { method, params },
  });
}

/**
 * Replace Deno.readDir for exactly one directory. `hide` sees every name of
 * one real listing and returns the names that listing must not show, which
 * is what an htree readdir racing a rename can do.
 */
function stubListing(
  directory: string,
  hide: (names: string[]) => Set<string>,
): () => void {
  Deno.readDir = (path: string | URL) => {
    if (String(path) !== directory) return realReadDir(path);
    return (async function* () {
      const entries: Deno.DirEntry[] = [];
      for await (const entry of realReadDir(path)) entries.push(entry);
      const hidden = hide(entries.map((entry) => entry.name));
      for (const entry of entries) if (!hidden.has(entry.name)) yield entry;
    })();
  };
  return () => {
    Deno.readDir = realReadDir;
  };
}

/** Hide frame k until one listing has shown frame k+1 without it. */
function listLaterFrameFirst(
  directory: string,
  frame: () => number | null,
): { restore(): void; inverted(): boolean } {
  let inverted = false;
  const restore = stubListing(directory, (names) => {
    const k = frame();
    if (k === null || inverted) return new Set();
    const hidden = new Set(names.filter((name) => counterOf(name) === k));
    if (names.some((name) => counterOf(name) === k + 1)) inverted = true;
    return hidden;
  });
  return { restore, inverted: () => inverted };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function openClient(
  directory: string,
  gapDeadlineMs?: number,
): { client: ReviewOwnerChannelClient; seqs: number[] } {
  const client = new ReviewOwnerChannelClient(
    { version: "v1", directory, ownerRunId: OWNER_RUN },
    gapDeadlineMs,
  );
  const session = client.openSession({
    cwd: "/x",
    requestId: "A",
    invocationId: "inv",
    ownerRunId: OWNER_RUN,
  });
  const seqs: number[] = [];
  session.onNotification((event) => {
    seqs.push((event.params as { seq: number }).seq);
  });
  return { client, seqs };
}

async function tempChannel(): Promise<string> {
  return await Deno.makeTempDir({ dir: ROOT, prefix: "sentinel-channel-" });
}

/** Collect the client's skipped-frame lines; every other line passes through. */
function captureSkips(): { lines: string[]; restore(): void } {
  const realLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    if (text.includes("sentinel_review_channel_frame_skip")) {
      lines.push(text);
    } else realLog(...args);
  };
  return {
    lines,
    restore: () => {
      console.log = realLog;
    },
  };
}

function skippedCounters(lines: string[], deadlineMs: number): number[] {
  return lines.map((line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(Object.keys(value), ["event", "counter", "waitedMs"]);
    assert.equal(value.event, "sentinel_review_channel_frame_skipped");
    assert.ok(Number.isInteger(value.waitedMs));
    assert.ok((value.waitedMs as number) >= deadlineMs);
    return value.counter as number;
  });
}

/** Minimal owner side for RPC only: every request is answered with "ok". */
function answerRequests(directory: string): () => Promise<void> {
  const answered = new Set<string>();
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      for await (const file of realReadDir(directory)) {
        const match = /^request-([0-9a-f-]{36})\.json$/.exec(file.name);
        if (match === null || answered.has(match[1]!)) continue;
        answered.add(match[1]!);
        await writeReviewChannelFile(
          directory + "/response-" + match[1] + ".json",
          { id: match[1], result: "ok" },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return async () => {
    stop = true;
    await loop;
  };
}

/** Count listings of one directory without changing what they show. */
function countListings(directory: string): {
  count(): number;
  restore(): void;
} {
  let listings = 0;
  const restore = stubListing(directory, () => {
    listings++;
    return new Set();
  });
  return { count: () => listings, restore };
}

Deno.test("review channel: a listing that shows frame k+1 before frame k still dispatches k then k+1", async () => {
  const directory = await tempChannel();
  const listing = listLaterFrameFirst(directory, () => 1);
  const { client, seqs } = openClient(directory);
  try {
    // Non-event files the directory can hold are never dispatched or faulted on.
    await Deno.writeTextFile(directory + "/notes.txt", "x");
    await Deno.writeTextFile(directory + "/event-legacy.json", "{}");
    await Deno.writeTextFile(
      directory + "/" + frameName(9) + "." + crypto.randomUUID() + ".tmp",
      "{",
    );
    await writeReviewChannelFile(
      directory + "/response-" + crypto.randomUUID() + ".json",
      { id: crypto.randomUUID(), result: null },
    );
    await writeEvent(directory, 1, "A", "item/started", { seq: 1 });
    await writeEvent(directory, 2, "A", "item/completed", { seq: 2 });
    assert.ok(await waitFor(listing.inverted, 3_000), "reorder was injected");
    await Deno.writeTextFile(directory + "/poke.txt", "x");
    await waitFor(() => seqs.length >= 2, 3_000);
    assert.deepEqual(seqs, [1, 2]);
  } finally {
    await client.close();
    listing.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: a gap fills on the client's own rescan with no further fs event", async () => {
  const directory = await tempChannel();
  // The final frames are already written: nothing will touch the directory again.
  for (const counter of [1, 2, 3]) {
    await writeEvent(directory, counter, "A", "item/started", { seq: counter });
  }
  let listings = 0;
  const restore = stubListing(directory, (names) => {
    listings++;
    return new Set(
      listings === 1 ? names.filter((name) => counterOf(name) === 1) : [],
    );
  });
  const probe = Deno.watchFs(directory, { recursive: false });
  let fsEvents = 0;
  const probed = (async () => {
    for await (const event of probe) {
      if (event.kind !== "remove") fsEvents++;
    }
  })();
  const { client, seqs } = openClient(directory);
  try {
    await waitFor(() => seqs.length >= 3, 3_000);
    assert.deepEqual(seqs, [1, 2, 3]);
    assert.ok(listings >= 2, "the gap was filled by a later listing");
    assert.equal(fsEvents, 0, "no fs event drove that listing");
  } finally {
    await client.close();
    probe.close();
    await probed;
    restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: a gap that outlives the deadline skips exactly that counter and the channel stays healthy", async () => {
  const directory = await tempChannel();
  // Frame 1 never appears (an owner write that failed); frame 2 is visible.
  await writeEvent(directory, 2, "A", "item/completed", { seq: 2 });
  const skips = captureSkips();
  const stopAnswering = answerRequests(directory);
  const started = Date.now();
  const { client, seqs } = openClient(directory, 300);
  try {
    // Responses are matched by id while the event gap is open.
    assert.equal(await client.call("open", { requestId: "A" }), "ok");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(seqs, [], "frame 2 waits for frame 1 within the deadline");
    assert.ok(await waitFor(() => seqs.length >= 1, 3_000));
    assert.ok(Date.now() - started >= 300, "not skipped before the deadline");
    assert.deepEqual(seqs, [2]);
    assert.deepEqual(skippedCounters(skips.lines, 300), [1]);
    // A frame for a skipped counter that shows up late is never delivered;
    // later frames and calls go through as before.
    await writeEvent(directory, 1, "A", "item/started", { seq: 1 });
    await writeEvent(directory, 3, "A", "turn/completed", { seq: 3 });
    assert.ok(await waitFor(() => seqs.length >= 2, 3_000));
    assert.equal(await client.call("send", { requestId: "A" }), "ok");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(seqs, [2, 3]);
    assert.equal(skips.lines.length, 1);
  } finally {
    await client.close();
    await stopAnswering();
    skips.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: frames released by a skip never restart the shared deadline", async () => {
  const directory = await tempChannel();
  // 1, 3, 5 and 7 were never written; 2, 4 and 6 sit between them and 8 is
  // visible from the first listing. Every frame was listed with the hole, so
  // the frames each skip releases are not progress: all four counters go
  // after about one deadline, never one deadline each (2 s).
  for (const counter of [2, 4, 6, 8]) {
    await writeEvent(directory, counter, "A", "item/started", { seq: counter });
  }
  const skips = captureSkips();
  const started = Date.now();
  const { client, seqs } = openClient(directory, 500);
  try {
    assert.ok(await waitFor(() => seqs.length >= 4, 5_000));
    const elapsed = Date.now() - started;
    assert.deepEqual(seqs, [2, 4, 6, 8]);
    assert.deepEqual(skippedCounters(skips.lines, 500), [1, 3, 5, 7]);
    assert.ok(elapsed >= 500 && elapsed < 1_000, "elapsed " + elapsed);
  } finally {
    await client.close();
    skips.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: counters already missing under one later frame share a single deadline", async () => {
  const directory = await tempChannel();
  // 2, 3, 4 and 7 were never written; 8 is visible from the first listing.
  for (const counter of [1, 5, 6, 8]) {
    await writeEvent(directory, counter, "A", "item/started", { seq: counter });
  }
  const skips = captureSkips();
  const started = Date.now();
  const { client, seqs } = openClient(directory, 500);
  try {
    assert.ok(await waitFor(() => seqs.length >= 4, 5_000));
    const elapsed = Date.now() - started;
    assert.deepEqual(seqs, [1, 5, 6, 8]);
    assert.deepEqual(skippedCounters(skips.lines, 500), [2, 3, 4, 7]);
    // One deadline for the whole hole, never one per missing counter (2 s).
    assert.ok(elapsed >= 500 && elapsed < 1_500, "elapsed " + elapsed);
  } finally {
    await client.close();
    skips.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

/**
 * The owner's emit(): the global counter is taken at emit time and the frame
 * is written behind its entry's own tail. `paceMs` delays every write of that
 * entry, which is what a backed-up per-entry write queue looks like from the
 * client: its frames keep landing in order, each long after a later frame of
 * another entry became visible.
 */
function ownerEmitter(directory: string) {
  let counter = 0;
  const tails = new Map<string, Promise<void>>();
  return {
    /** A counter the owner takes but never writes (a refused frame). */
    refuse: () => ++counter,
    tail: (requestId: string) => tails.get(requestId) ?? Promise.resolve(),
    emit(requestId: string, seq: number, paceMs = 0): Promise<void> {
      const frame = ++counter;
      const task = (tails.get(requestId) ?? Promise.resolve()).then(
        async () => {
          if (paceMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, paceMs));
          }
          await writeEvent(directory, frame, requestId, "delta", { seq });
        },
      );
      tails.set(requestId, task);
      return task;
    },
  };
}

function openNoise(client: ReviewOwnerChannelClient): number[] {
  const seqs: number[] = [];
  client.openSession({
    cwd: "/x",
    requestId: "N",
    invocationId: "inv",
    ownerRunId: OWNER_RUN,
  }).onNotification((event) => {
    seqs.push((event.params as { seq: number }).seq);
  });
  return seqs;
}

Deno.test("review channel: a backed-up entry still landing its frames in order loses none while a later frame is visible far past the deadline", async () => {
  const directory = await tempChannel();
  const deadlineMs = 300;
  const skips = captureSkips();
  const { client, seqs } = openClient(directory, deadlineMs);
  const noise = openNoise(client);
  const owner = ownerEmitter(directory);
  try {
    // A takes counters 1..40 at once; its queue lands one every 30 ms (1.2 s,
    // four deadlines). N's frames, above all of them, land at once.
    for (let seq = 0; seq < 40; seq++) owner.emit("A", seq, 30);
    let drained = false;
    owner.tail("A").then(() => {
      drained = true;
    });
    const started = performance.now();
    let sent = 0;
    while (!drained) {
      await owner.emit("N", sent++);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(performance.now() - started >= 3 * deadlineMs, "outlived");
    await waitFor(() => seqs.length >= 40 && noise.length >= sent, 3_000);
    assert.deepEqual(seqs, [...Array(40).keys()]);
    assert.deepEqual(noise, [...Array(sent).keys()]);
    assert.deepEqual(skips.lines, []);
  } finally {
    await client.close();
    await owner.tail("A").catch(() => {});
    skips.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: a counter that never lands behind a draining entry is skipped about one deadline after its last frame landed", async () => {
  const directory = await tempChannel();
  const deadlineMs = 300;
  const skips = captureSkips();
  const { client, seqs } = openClient(directory, deadlineMs);
  const noise = openNoise(client);
  const owner = ownerEmitter(directory);
  try {
    // A's counters 1..20 land one every 30 ms (0.6 s); 21 was refused by the
    // owner; N's 22 is visible from the start.
    for (let seq = 0; seq < 20; seq++) owner.emit("A", seq, 30);
    const refused = owner.refuse();
    await owner.emit("N", 0);
    await owner.tail("A");
    const landed = performance.now();
    assert.ok(await waitFor(() => noise.length >= 1, 3_000));
    const waited = performance.now() - landed;
    assert.deepEqual(seqs, [...Array(20).keys()]);
    assert.deepEqual(noise, [0]);
    assert.deepEqual(skippedCounters(skips.lines, deadlineMs), [refused]);
    // Timed from A's last frame, not from when N's frame became visible.
    assert.ok(
      waited >= deadlineMs - 50 && waited < 3 * deadlineMs,
      "" + waited,
    );
  } finally {
    await client.close();
    skips.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: skipping a refused counter does not skip a backed-up entry still landing its frames above it", async () => {
  const directory = await tempChannel();
  const deadlineMs = 300;
  const skips = captureSkips();
  const { client, seqs } = openClient(directory, deadlineMs);
  const noise = openNoise(client);
  const owner = ownerEmitter(directory);
  try {
    // Counter 1 was refused. A takes 2..41 at once and its queue lands one
    // every 30 ms (1.2 s, four deadlines); N's frames, above all of them, keep
    // landing from the start, so the hole under them outlives the deadline
    // while A is still landing.
    const refused = owner.refuse();
    for (let seq = 0; seq < 40; seq++) owner.emit("A", seq, 30);
    let drained = false;
    owner.tail("A").then(() => {
      drained = true;
    });
    let sent = 0;
    while (!drained) {
      await owner.emit("N", sent++);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(skips.lines.length >= 1, "the skip came while A was landing");
    await waitFor(() => seqs.length >= 40 && noise.length >= sent, 3_000);
    assert.deepEqual(seqs, [...Array(40).keys()]);
    assert.deepEqual(noise, [...Array(sent).keys()]);
    assert.deepEqual(skippedCounters(skips.lines, deadlineMs), [refused]);
  } finally {
    await client.close();
    await owner.tail("A").catch(() => {});
    skips.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: past the skipped-frame line cap one cumulative count line is printed and later skips stay silent", async () => {
  const directory = await tempChannel();
  // Counters 1..54 never landed; 55 is visible from the first listing.
  await writeEvent(directory, 55, "A", "item/started", { seq: 55 });
  const skips = captureSkips();
  const { client, seqs } = openClient(directory, 100);
  try {
    assert.ok(await waitFor(() => seqs.length >= 1, 3_000));
    // A later hole: 56 never lands, 57 does.
    await writeEvent(directory, 57, "A", "item/completed", { seq: 57 });
    assert.ok(await waitFor(() => seqs.length >= 2, 3_000));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(seqs, [55, 57]);
    assert.equal(skips.lines.length, 51);
    assert.deepEqual(
      skippedCounters(skips.lines.slice(0, 50), 100),
      [...Array(50).keys()].map((n) => n + 1),
    );
    // Fixed shape and no frame content: the count through the skip run that
    // first passed the cap.
    assert.deepEqual(JSON.parse(skips.lines[50]!), {
      event: "sentinel_review_channel_frame_skip_lines_capped",
      skipped: 54,
    });
  } finally {
    await client.close();
    skips.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: a frame a listing past the deadline missed is delivered on the confirming listing", async () => {
  const directory = await tempChannel();
  for (const counter of [1, 2]) {
    await writeEvent(directory, counter, "A", "item/started", { seq: counter });
  }
  // Frame 1 is renamed exactly while the first listing past the deadline
  // runs: every listing up to and including that one misses it.
  let holeListed: number | null = null;
  let pastDeadline = 0;
  Deno.readDir = (path: string | URL) => {
    if (String(path) !== directory) return realReadDir(path);
    const startedAt = performance.now();
    return (async function* () {
      const entries: Deno.DirEntry[] = [];
      for await (const entry of realReadDir(path)) entries.push(entry);
      if (holeListed !== null && startedAt >= holeListed + 300) pastDeadline++;
      for (const entry of entries) {
        if (pastDeadline < 2 && counterOf(entry.name) === 1) continue;
        yield entry;
      }
      holeListed ??= performance.now();
    })();
  };
  const skips = captureSkips();
  const { client, seqs } = openClient(directory, 300);
  try {
    assert.ok(await waitFor(() => seqs.length >= 2, 3_000));
    assert.deepEqual(seqs, [1, 2]);
    assert.ok(pastDeadline >= 2, "the confirming listing ran");
    assert.deepEqual(skips.lines, []);
  } finally {
    await client.close();
    Deno.readDir = realReadDir;
    skips.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: a missing frame with nothing after it never rescans on its own", async () => {
  const directory = await tempChannel();
  await writeEvent(directory, 1, "A", "item/started", { seq: 1 });
  const listings = countListings(directory);
  const skips = captureSkips();
  const { client, seqs } = openClient(directory, 100);
  try {
    assert.ok(await waitFor(() => seqs.length >= 1, 3_000));
    // Frame 2 is never written and nothing later is visible: no gap, no spin.
    const quiet = listings.count();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(listings.count(), quiet);
    // A later frame opens the gap; it is skipped after the deadline.
    await writeEvent(directory, 3, "A", "item/completed", { seq: 3 });
    assert.ok(await waitFor(() => seqs.length >= 2, 3_000));
    assert.deepEqual(seqs, [1, 3]);
    assert.deepEqual(skippedCounters(skips.lines, 100), [2]);
    // Nothing is held after the skip: the client stops rescanning again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = listings.count();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(listings.count(), settled);
  } finally {
    await client.close();
    skips.restore();
    listings.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: close during a gap stops its rescans and skips nothing", async () => {
  const directory = await tempChannel();
  await writeEvent(directory, 2, "A", "item/completed", { seq: 2 });
  const listings = countListings(directory);
  const skips = captureSkips();
  const { client, seqs } = openClient(directory, 300);
  try {
    assert.ok(await waitFor(() => listings.count() >= 3, 3_000), "rescanning");
    await client.close();
    const closed = listings.count();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(listings.count(), closed);
    assert.deepEqual(seqs, []);
    assert.deepEqual(skips.lines, []);
    await assert.rejects(
      client.call("open", { requestId: "A" }),
      /review custody channel closed/,
    );
  } finally {
    await client.close();
    skips.restore();
    listings.restore();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("review channel: real-fs stress with the owner's naming delivers every entry event in order", async () => {
  const directory = await tempChannel();
  let counter = 0;
  // Accumulated frames of other reviews, never deleted during a run.
  for (let index = 0; index < 400; index++) {
    await writeEvent(directory, ++counter, "old-" + (index % 7), "noise", {
      seq: index,
    });
  }
  const { client, seqs } = openClient(directory);
  // Owner emit(): global counter taken at emit time, one write tail per entry.
  const tails = new Map<string, Promise<void>>();
  const emit = (requestId: string, method: string, seq: number) => {
    const frame = ++counter;
    const task = (tails.get(requestId) ?? Promise.resolve()).then(() =>
      writeEvent(directory, frame, requestId, method, { seq })
    );
    tails.set(requestId, task);
    return task;
  };
  try {
    let seq = 0;
    let stop = false;
    const noise = [0, 1, 2, 3].map(async (entry) => {
      for (let index = 0; !stop; index++) {
        await emit("N" + entry, "item/agentMessage/delta", index);
      }
    });
    for (let command = 0; command < 200; command++) {
      emit("A", "item/started", seq++);
      if (command % 2 === 1) {
        emit("A", "item/commandExecution/outputDelta", seq++);
      }
      await emit("A", "item/completed", seq++);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
    }
    stop = true;
    await Promise.all(noise);
    await waitFor(() => seqs.length >= seq, 60_000);
    let inversions = 0;
    for (let index = 1; index < seqs.length; index++) {
      if (seqs[index]! < seqs[index - 1]!) inversions++;
    }
    assert.equal(inversions, 0);
    assert.deepEqual(seqs, [...Array(seq).keys()]);
  } finally {
    await client.close();
    await Deno.remove(directory, { recursive: true });
  }
});

const OWNER_EXECUTION = {
  id: "7:2:repair",
  runId: 7,
  runAttempt: 2,
  launcherSha: "a".repeat(40) as GitSha,
  revision: "b".repeat(40) as GitSha,
  generation: 76,
  purpose: "ordinary" as const,
  releaseId: null,
  createdAt: Date.now() - 1000,
};
const OWNER_REPOSITORY = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

/** The live broker and its awaited private emit(): this pins the naming. */
function realOwner(parent: string) {
  const broker = new ReviewOwnerCustodyBroker(OWNER_EXECUTION, [{
    repository: OWNER_REPOSITORY,
    provider: PROVIDER,
    model: "gpt-reserve",
    permissionProfile: REVIEW_PROFILE,
    session: {
      command: ["true"],
      cwd: parent,
      env: {},
      operationDeadlineMs: 1,
    },
  }]);
  const emit = (broker as unknown as {
    emit(entry: unknown, type: string, event: unknown): Promise<void>;
  }).emit.bind(broker);
  const entry = (requestId: string) => ({
    registration: { journal: { requestId } },
    eventTail: Promise.resolve(),
    faulted: false,
  });
  return { broker, emit, entry };
}

Deno.test("review channel: frames written by the real owner emit() dispatch from its first counter", async () => {
  const parent = await tempChannel();
  const { broker, emit, entry } = realOwner(parent);
  const descriptor = await broker.start(parent);
  let client: ReviewOwnerChannelClient | undefined;
  try {
    const a = entry("A");
    const b = entry("B");
    for (let seq = 0; seq < 60; seq++) {
      await emit(a, "notification", {
        method: "item/started",
        params: { seq },
      });
      await emit(b, "notification", { method: "noise", params: { seq } });
    }
    const counters = [...Deno.readDirSync(descriptor.directory)]
      .map((file) => counterOf(file.name))
      .filter((counter) => counter !== null)
      .sort((x, y) => x - y);
    assert.deepEqual(counters, [...Array(120).keys()].map((n) => n + 1));
    const opened = openClient(descriptor.directory);
    client = opened.client;
    await waitFor(() => opened.seqs.length >= 60, 5_000);
    assert.deepEqual(opened.seqs, [...Array(60).keys()]);
  } finally {
    await client?.close();
    await broker.dispose();
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("review channel: an unsupported oversized control frame costs only its own review", async () => {
  const parent = await tempChannel();
  const { broker, emit, entry } = realOwner(parent);
  const descriptor = await broker.start(parent);
  const skips = captureSkips();
  const client = new ReviewOwnerChannelClient(descriptor, 300);
  const delivered: string[] = [];
  for (const requestId of ["A", "B"]) {
    client.openSession({
      cwd: "/x",
      requestId,
      invocationId: "inv",
      ownerRunId: descriptor.ownerRunId,
    }).onNotification((event) => {
      delivered.push(requestId + ":" + event.method);
    });
  }
  try {
    const a = entry("A");
    const b = entry("B");
    await emit(a, "notification", { method: "turn/started", params: {} });
    // This bypasses transport validation to exercise impossible control data,
    // not an eligible verbose output string (which the transport projects).
    await emit(b, "notification", {
      method: "item/completed",
      params: { control: "x".repeat(REVIEW_CHANNEL_BOUND) },
    });
    await emit(a, "notification", { method: "item/started", params: {} });
    await emit(a, "notification", { method: "item/completed", params: {} });
    await emit(a, "notification", { method: "turn/completed", params: {} });
    await Promise.all([a.eventTail, b.eventTail]);
    assert.deepEqual([a.faulted, b.faulted], [false, true]);
    assert.ok(await waitFor(() => delivered.length >= 4, 3_000));
    assert.deepEqual(delivered, [
      "A:turn/started",
      "A:item/started",
      "A:item/completed",
      "A:turn/completed",
    ]);
    assert.deepEqual(skippedCounters(skips.lines, 300), [2]);
    // The channel itself stays healthy: a later call is served by the owner.
    const journal = {
      version: "v1" as const,
      phase: "intent" as const,
      repository: { owner: "ubiquity-sentinel", name: "sentinel" },
      prNumber: 1,
      expectedHead: "c".repeat(40) as GitSha,
      expectedBase: "d".repeat(40) as GitSha,
      operationKey: "review:task:round1",
      publisher: "ubiquity-sentinel[bot]",
      requestId: "review-review:task:round1",
      requestedAt: Date.now(),
      ownerExecution: OWNER_EXECUTION,
    };
    await client.register(
      await reviewOwnerRegistration(
        OWNER_REPOSITORY,
        100,
        journal,
        renderReviewJournalBody(journal),
      ),
    );
  } finally {
    await client.close();
    skips.restore();
    await broker.dispose();
    await Deno.remove(parent, { recursive: true });
  }
});

/** Minimal owner: answers the client's RPC frames and emits like the broker. */
class ScriptedChannelOwner {
  startedFrame: number | null = null;
  private counter = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly answered = new Set<string>();
  private readonly watcher: Deno.FsWatcher;
  private readonly loop: Promise<void>;

  constructor(readonly directory: string) {
    const watcher = Deno.watchFs(directory, { recursive: false });
    this.watcher = watcher;
    this.loop = (async () => {
      for await (const _event of watcher) await this.serve();
    })();
  }

  async close(): Promise<void> {
    this.watcher.close();
    await this.loop;
    await this.tail;
  }

  private emit(method: string, params: unknown): void {
    const frame = ++this.counter;
    if (
      method === "item/started" &&
      (params as { item?: { type?: string } }).item?.type === "commandExecution"
    ) this.startedFrame = frame;
    this.tail = this.tail.then(() =>
      writeEvent(this.directory, frame, "request-1", method, params)
    );
  }

  private async serve(): Promise<void> {
    for await (const file of realReadDir(this.directory)) {
      const match = /^request-([0-9a-f-]{36})\.json$/.exec(file.name);
      if (match === null || this.answered.has(match[1]!)) continue;
      this.answered.add(match[1]!);
      const request = JSON.parse(
        await Deno.readTextFile(this.directory + "/" + file.name),
      ) as { id: string; method: string; params: Record<string, unknown> };
      const send = request.method === "send" ? request.params.method : null;
      const result = request.method === "close"
        ? { settled: true, eventThrough: this.counter, faulted: false }
        : send === "initialize"
        ? { userAgent: "scripted/0.1.0" }
        : send === "thread/start"
        ? {
          thread: { id: "thread-1" },
          model: "gpt-reserve",
          modelProvider: PROVIDER,
          reasoningEffort: "max",
          activePermissionProfile: { id: REVIEW_PROFILE },
        }
        : send === "review/start"
        ? {
          turn: { id: "turn-1", status: "inProgress" },
          reviewThreadId: "thread-1",
        }
        : null;
      await writeReviewChannelFile(
        this.directory + "/response-" + request.id + ".json",
        { id: request.id, result },
      );
      if (send !== "review/start") continue;
      // A fast command: no output delta between its start and completion.
      const scope = { threadId: "thread-1", turnId: "turn-1" };
      const entry = {
        ...scope,
        item: {
          type: "enteredReviewMode",
          id: "native-entry",
          review: "custom review",
        },
      };
      this.emit("item/started", entry);
      this.emit("item/completed", entry);
      this.emit("item/started", {
        ...scope,
        item: commandItem("cmd-1", "inProgress"),
      });
      this.emit("item/completed", {
        ...scope,
        item: commandItem("cmd-1", "completed"),
      });
      const params = request.params.params as {
        target: { instructions: string };
      };
      const bindingMatch = /<SENTINEL_NATIVE_REVIEW_V1>\{"binding":(\{[^}]+\})/
        .exec(params.target.instructions);
      assert.ok(bindingMatch);
      const review = "<SENTINEL_NATIVE_REVIEW_V1>" +
        JSON.stringify({
          binding: JSON.parse(bindingMatch[1]),
          result: CLEAN_RESULT,
        }) + "</SENTINEL_NATIVE_REVIEW_V1>";
      const exit = {
        ...scope,
        item: { type: "exitedReviewMode", id: "item-final", review },
      };
      this.emit("item/started", exit);
      this.emit("item/completed", exit);
      this.emit("turn/completed", turnCompleted("turn-1"));
    }
  }
}

Deno.test("review channel: a fast command delivered through custody with completion listed first is not refused", async () => {
  const directory = await tempChannel();
  const owner = new ScriptedChannelOwner(directory);
  const listing = listLaterFrameFirst(directory, () => owner.startedFrame);
  const client = new ReviewOwnerChannelClient({
    version: "v1",
    directory,
    ownerRunId: OWNER_RUN,
  });
  const delivered: string[] = [];
  try {
    const reviewer = new CodexStructuredReviewer({
      provider: PROVIDER,
      openSession: (input) => {
        const session = client.openSession(input);
        const register = session.onNotification.bind(session);
        session.onNotification = (handler) =>
          register((event: CodexServerNotificationV1) => {
            delivered.push(event.method);
            handler(event);
          });
        return session;
      },
      sessionCwd: SESSION_CWD,
      permissionProfile: REVIEW_PROFILE,
    });
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture(), { ownerRunId: OWNER_RUN }),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const outcome = await prepared.value.start();
    const closed = await prepared.value.close();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.ok(listing.inverted(), "the completion frame was listed first");
    assert.equal(outcome.value.detail, null);
    assert.equal(outcome.value.status, "clean");
    assert.deepEqual(delivered, [
      "item/started",
      "item/completed",
      "item/started",
      "item/completed",
      "item/started",
      "item/completed",
      "turn/completed",
    ]);
    assert.equal(closed.settled, true);
    assert.equal(closed.failure, null);
  } finally {
    await client.close();
    await owner.close();
    listing.restore();
    await Deno.remove(directory, { recursive: true });
  }
});
