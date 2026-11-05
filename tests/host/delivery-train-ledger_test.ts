/** Sentinel #330: the train ledger parses fail closed; CI unread is not red. */
import assert from "node:assert/strict";
import {
  EMPTY_DELIVERY_TRAIN_LEDGER,
  parseDeliveryTrainLedgerV1,
} from "../../ops/hosted-autonomy-train-types.ts";
import { trainCiVerdict } from "../../ops/hosted-autonomy-train-members.ts";
import {
  createHostedAutonomyGitHub,
  type HostedAutonomyGitHubV1,
} from "../../ops/hosted-autonomy.ts";
import { jsonResponse } from "./hosted-autonomy-fixtures.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const OP = "0123456789abcdef01234567";

function member(overrides: Record<string, unknown> = {}) {
  return {
    recordId: "issue-ubiquity-ai.ubq.fi-200",
    pullRequest: 500,
    head: A,
    base: B,
    receiptId: `review-receipt:${"c".repeat(64)}`,
    commit: A,
    patch: "d".repeat(64),
    landedOn: null,
    revision: null,
    ...overrides,
  };
}

function train(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OP,
    ref: `refs/heads/sentinel-trains/${OP}`,
    tip: B,
    attempt: 1,
    sha: A,
    members: [member()],
    phase: "published",
    pendingMerge: null,
    createdAt: 1,
    ...overrides,
  };
}

Deno.test("train ledger: a well-formed ledger round-trips", () => {
  const ledger = { ...EMPTY_DELIVERY_TRAIN_LEDGER, train: train() };
  assert.deepEqual(parseDeliveryTrainLedgerV1(ledger), ledger);
  assert.deepEqual(
    parseDeliveryTrainLedgerV1(EMPTY_DELIVERY_TRAIN_LEDGER),
    EMPTY_DELIVERY_TRAIN_LEDGER,
  );
});

Deno.test("train ledger: any other shape is refused, never guessed", () => {
  const bad = [
    train({ ref: "refs/heads/main" }),
    train({ sha: B }),
    train({ attempt: 3 }),
    train({ pendingMerge: 1 }),
    train({ members: [] }),
    train({ members: [member({ landedOn: A })] }),
    train({ members: [member({ patch: "short" })] }),
    { ...train(), extra: true },
  ];
  for (const value of bad) {
    assert.equal(
      parseDeliveryTrainLedgerV1({
        ...EMPTY_DELIVERY_TRAIN_LEDGER,
        train: value,
      }),
      null,
      JSON.stringify(value),
    );
  }
  assert.equal(parseDeliveryTrainLedgerV1(null), null);
  assert.equal(
    parseDeliveryTrainLedgerV1({
      ...EMPTY_DELIVERY_TRAIN_LEDGER,
      version: "v2",
    }),
    null,
  );
});

function surface(
  green: boolean | null,
  failed: string[] | null,
): HostedAutonomyGitHubV1 {
  return {
    hasAllChecksGreen: () => Promise.resolve(green),
    failedChecks: () => Promise.resolve(failed),
    listHeadRuns: () =>
      Promise.resolve([{
        id: 41,
        headSha: A,
        status: "completed",
        conclusion: "failure",
        runAttempt: 1,
        createdAt: null,
      }]),
  } as unknown as HostedAutonomyGitHubV1;
}

Deno.test("train CI: green, red with run and check, pending and unavailable", async () => {
  assert.deepEqual(await trainCiVerdict(surface(true, []), A, B), {
    kind: "green",
  });
  assert.deepEqual(
    await trainCiVerdict(surface(false, ["lint", "e2e"]), A, B),
    {
      kind: "red",
      runId: 41,
      check: "e2e",
    },
  );
  assert.deepEqual(await trainCiVerdict(surface(false, []), A, B), {
    kind: "pending",
  });
  // An unreadable listing (or failed-check read) is no evidence, never red.
  assert.deepEqual(await trainCiVerdict(surface(null, ["e2e"]), A, B), {
    kind: "unavailable",
  });
  assert.deepEqual(await trainCiVerdict(surface(false, null), A, B), {
    kind: "unavailable",
  });
});

Deno.test("train surface: readCommitTree reads exactly the named commit's tree", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    // B's response names another commit: it is not B's tree.
    if (path.endsWith(`/commits/${A}`) || path.endsWith(`/commits/${B}`)) {
      return Promise.resolve(
        jsonResponse({ sha: A, commit: { tree: { sha: B } } }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  try {
    const surface = createHostedAutonomyGitHub("fixture-token", {
      owner: "ubiquity",
      name: "passport.ubq.fi",
      installationId: 9,
    });
    assert.equal(await surface.readCommitTree?.(A), B);
    assert.equal(await surface.readCommitTree?.(B), null);
    assert.equal(await surface.readCommitTree?.("not-a-sha"), null);
  } finally {
    globalThis.fetch = original;
  }
});
