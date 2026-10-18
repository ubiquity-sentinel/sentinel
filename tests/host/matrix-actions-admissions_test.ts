/** Historical non-start evidence, verification refusal and bounded fresh admission. */
import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import type { ImplementationPort } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { MAX_MATRIX_ARTIFACT_BYTES } from "../../src/contracts/matrix.ts";
import {
  historicalNotStartedProven,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { MemoryState } from "../repair/helpers.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { issueWire } from "../github/helpers.ts";
import { T0 } from "../state/helpers.ts";
import { issue, rig } from "./matrix-actions-fixtures.ts";

Deno.test("historical not started: only the exact authenticated window and null-receipt result prove non-start", () => {
  const wave = {
    reason: "reservation_after_manifest" as const,
    plannerStartedAt: new Date(T0).toISOString(),
    plannerCompletedAt: new Date(T0 + 3_600_000).toISOString(),
  };
  const admission = { id: "r-historical", createdAt: T0 + 1_000 };
  const cell = {
    cellId: "cell-historical",
    taskId: "issue-ubiquity-sentinel-1" as WorkItemId,
    reservationId: "r-historical",
    status: "not_started" as const,
    receiptNull: true,
    bundleNull: true,
    completedAt: T0 + 2_000,
    resultDigest: "a".repeat(64),
  };
  assert.equal(
    historicalNotStartedProven(wave, cell, admission),
    true,
    "the exact authenticated not-started admission is proven",
  );
  assert.equal(
    historicalNotStartedProven(
      wave,
      { ...cell, status: "completed" },
      admission,
    ),
    false,
    "a completed payload is never a not-started recovery",
  );
  assert.equal(
    historicalNotStartedProven(
      wave,
      { ...cell, receiptNull: false },
      admission,
    ),
    false,
    "a receipt-bearing payload is never a not-started recovery",
  );
  assert.equal(
    historicalNotStartedProven(wave, { ...cell, bundleNull: false }, admission),
    false,
    "a bundle-bearing payload is never a not-started recovery",
  );
  assert.equal(
    historicalNotStartedProven(
      wave,
      { ...cell, reservationId: "other" },
      admission,
    ),
    false,
    "evidence for another reservation is never adopted",
  );
  assert.equal(
    historicalNotStartedProven(wave, undefined, admission),
    false,
    "missing evidence is never inferred",
  );
  assert.equal(
    historicalNotStartedProven(wave, cell, {
      id: "r-historical",
      createdAt: T0 - 1,
    }),
    false,
    "an admission before the planner window is refused",
  );
  assert.equal(
    historicalNotStartedProven(wave, cell, {
      id: "r-historical",
      createdAt: T0 + 3_600_001,
    }),
    false,
    "an admission after the planner window is refused",
  );
  assert.equal(
    historicalNotStartedProven(
      { ...wave, plannerCompletedAt: "not-a-time" },
      cell,
      admission,
    ),
    false,
    "a malformed authenticated window fails closed",
  );
});

Deno.test("matrix actions: ordinary missing-health and verification purposes produce zero model admissions", async () => {
  for (
    const purpose of [
      "ordinary",
      "bootstrap",
      "prior",
      "candidate",
      "rollback",
    ] as const
  ) {
    const r = await rig(false, purpose);
    try {
      let starts = 0;
      const result = await runActionsMatrixHost({
        ...await r.job("verify", "matrix_plan"),
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            starts++;
            throw Error("verification cannot infer");
          },
        },
      });
      assert.ok("plan" in result);
      assert.equal(result.prepared, 0);
      assert.equal(starts, 0);
      const state = await r.store.readRepair();
      assert.ok(state.ok && state.value.status === "found");
      assert.equal(state.value.snapshot.reservations.length, 0);
    } finally {
      await r.cleanup();
    }
  }
});

Deno.test("matrix actions: one wave durably admits 128 fresh issues through real paginated source intake", async () => {
  const r = await rig();
  try {
    const memory = new MemoryState();
    const release = await r.store.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    memory.setRelease(release.value.snapshot);
    const pages: number[] = [];
    const rows = Array.from({ length: 128 }, (_, index) =>
      issueWire({
        number: index + 1,
        title: "issue " + (index + 1),
        body: "body " + (index + 1),
        created_at: new Date(T0).toISOString(),
        updated_at: new Date(T0).toISOString(),
      }));
    const deps = await r.job("high-count", "matrix_plan");
    const client = new GitHubApiClient({
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      apiBaseUrl: "https://api.github.com",
      clock: r.clock,
      auth: {
        authorizationHeader: () => Promise.resolve(portOk("Bearer fake-token")),
      },
      cooldownGate: {
        beforeRequest: () => Promise.resolve(portOk(undefined)),
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      },
      includeIssueRelations: true,
      http: (request) => {
        const url = new URL(request.url);
        let body: unknown;
        const headers = new Headers();
        if (url.pathname === "/graphql") {
          const number = JSON.parse(request.body!).variables.number;
          body = {
            data: {
              repository: {
                issue: {
                  number,
                  blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
                  subIssues: { totalCount: 0 },
                },
              },
            },
          };
        } else if (url.pathname === "/repos/ubiquity/sentinel/issues") {
          const page = Number(url.searchParams.get("page"));
          pages.push(page);
          body = page === 1 ? rows.slice(0, 100) : rows.slice(100);
          if (page === 1) {
            headers.set(
              "link",
              '<https://api.github.com/repos/ubiquity/sentinel/issues?state=open&per_page=100&page=2>; rel="next"',
            );
          }
        } else {
          const number = Number(url.pathname.split("/").at(-1));
          body = rows[number - 1];
          if (body === undefined) throw new Error("unexpected source request");
        }
        return Promise.resolve({
          status: 200,
          headers,
          bodyText: JSON.stringify(body),
        });
      },
    });
    const port = r.github.get("ubiquity/sentinel")!;
    port.listOpenIssues = () => client.listOpenIssues();
    port.readIssue = (number) => client.readIssue(number);
    r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
      Promise.resolve(portOk([]));
    const planned = await runActionsMatrixHost({
      ...deps,
      state: memory,
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          throw new Error("planning cannot infer");
        },
      },
    });
    assert.ok("plan" in planned);
    assert.deepEqual(
      pages,
      [1, 2],
      "actual GitHub source must exhaust its second page",
    );
    assert.equal(
      planned.prepared,
      128,
      "one native wave must not stop at an artificial preparation limit",
    );
    assert.equal(memory.repair!.reservations.length, 128);
    assert.equal(
      new Set(memory.repair!.reservations.map((row) => row.id)).size,
      128,
    );
    assert.ok(
      memory.repair!.reservations.every((row) => row.outcome === "reserved"),
    );
    assert.equal(
      memory.repair!.work.filter((row) => row.intent?.kind === "implementation")
        .length,
      128,
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("matrix actions: manifest byte budget leaves overflow issues unreserved for a later wave", async () => {
  const r = await rig();
  try {
    const memory = new MemoryState();
    const release = await r.store.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    memory.setRelease(release.value.snapshot);
    const rows = Array.from({ length: 128 }, (_, index) => ({
      ...issue(index + 1),
      // Each statement is admissible; their combined manifest exceeds its bound.
      body: "X".repeat(16 * 1024),
    }));
    const source = r.github.get("ubiquity/sentinel")!;
    source.listOpenIssues = () => Promise.resolve(portOk(rows));
    source.readIssue = (number) =>
      Promise.resolve(portOk(rows[number - 1] ?? null));
    r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
      Promise.resolve(portOk([]));
    const model: ImplementationPort = {
      modelId: "gpt-reserve",
      runModel: () => {
        throw Error("planning cannot infer");
      },
    };
    let first: Awaited<ReturnType<typeof runActionsMatrixHost>> | null = null;
    try {
      first = await runActionsMatrixHost({
        ...await r.job("large-manifest", "matrix_plan"),
        state: memory,
        model,
      });
    } catch (error) {
      console.log(
        JSON.stringify({
          kind: "manifest_byte_failure",
          reservations: memory.repair?.reservations.length,
          intents: memory.repair?.work.filter((row) => row.intent !== null)
            .length,
        }),
      );
      throw error;
    }
    assert.ok("plan" in first);
    assert.ok(first.prepared > 0 && first.prepared < 128);
    assert.ok(
      (await Deno.stat(r.root + "/large-manifest/.sentinel-matrix/plan.json"))
        .size <= MAX_MATRIX_ARTIFACT_BYTES,
    );
    assert.equal(memory.repair!.reservations.length, first.prepared);
    assert.equal(
      memory.repair!.work.filter((row) => row.intent?.kind === "implementation")
        .length,
      first.prepared,
    );
    assert.ok(
      memory.repair!.work.filter((row) => row.intent === null).every((row) =>
        row.counters.attempts === 0
      ),
    );
    const firstCharges = structuredClone(memory.repair!.reservations);
    await r.advanceRun(72);
    const nextRelease = await r.store.readRelease();
    assert.ok(nextRelease.ok && nextRelease.value.status === "found");
    memory.setRelease(nextRelease.value.snapshot);
    const second = await runActionsMatrixHost({
      ...await r.job("later-manifest", "matrix_plan"),
      state: memory,
      model,
    });
    assert.ok("plan" in second);
    assert.equal(first.prepared + second.prepared, 128);
    assert.equal(memory.repair!.reservations.length, 128);
    assert.equal(
      new Set(memory.repair!.reservations.map((row) => row.id)).size,
      128,
    );
    assert.deepEqual(
      memory.repair!.reservations.slice(0, firstCharges.length),
      firstCharges,
    );
  } finally {
    await r.cleanup();
  }
});
