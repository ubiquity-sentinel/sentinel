/** The launcher must prove every member of a recent wave settled before moving. */
import assert from "node:assert/strict";
import {
  executionIntent,
  FollowFake,
  L,
  matrixWaveIndex,
  matrixWaveReservation,
  P,
  response,
} from "./hosted-runtime-follow-fixtures.ts";

const IDS = ["d".repeat(64), "e".repeat(64)];

function settledWave() {
  const api = new FollowFake();
  api.matrixIndex = matrixWaveIndex(
    executionIntent(41319256619, {
      revision: P,
      launcherSha: L,
      createdAt: api.now - 60_000,
    }),
    IDS,
  );
  for (const id of IDS) {
    api.repairReservations.set(
      id,
      matrixWaveReservation(id, api.now - 60_000, "submitted"),
    );
  }
  return api;
}

function indexLookup(url: URL) {
  return /\/git\/(?:ref|matching-refs)\/heads\/sentinel-state\/maintenance-index$/
    .test(url.pathname);
}

Deno.test("follow defers when the matrix index lookup is unavailable, not absent", async (t) => {
  for (const failure of ["transport", "server", "malformed"] as const) {
    await t.step(failure, async () => {
      const api = settledWave();
      api.intercept = (_request, url) => {
        if (!indexLookup(url)) return;
        if (failure === "transport") throw new Error("offline");
        return response({}, failure === "server" ? 503 : 200);
      };
      const result = await api.follow();
      assert.equal(result.journal.decision, "deferred");
      assert.equal(result.journal.reason, "matrix_wave_unreadable");
      assert.equal(api.mutations, 0);
      assert.equal(api.launcher, L);
    });
  }
});

Deno.test("follow does not mistake a missing plan reservation for a settled cell", async () => {
  const api = settledWave();
  api.repairReservations.delete(IDS[1]);
  const result = await api.follow();
  assert.equal(result.journal.decision, "deferred");
  assert.equal(result.journal.reason, "matrix_wave_unreadable");
  assert.equal(api.mutations, 0);
  assert.equal(api.launcher, L);
});

Deno.test("follow binds each settlement to the reservation named by its plan", async () => {
  const api = settledWave();
  api.repairReservations.get(IDS[1])!.id = "f".repeat(64);
  const result = await api.follow();
  assert.equal(result.journal.decision, "deferred");
  assert.equal(result.journal.reason, "matrix_wave_unreadable");
  assert.equal(api.mutations, 0);
  assert.equal(api.launcher, L);
});

Deno.test("follow accepts exact archived settlements but still holds an unsettled archive member", async () => {
  const api = settledWave();
  api.archivedReservations.add(IDS[1]);
  api.repairReservations.set(
    IDS[1],
    matrixWaveReservation(IDS[1], api.now - 60_000, "reserved"),
  );
  const held = await api.follow();
  assert.equal(held.journal.reason, "matrix_wave_in_flight");
  assert.equal(api.mutations, 0);
  api.repairReservations.set(
    IDS[1],
    matrixWaveReservation(IDS[1], api.now - 60_000, "submitted"),
  );
  const advanced = await api.follow();
  assert.equal(advanced.journal.decision, "advanced");
  assert.equal(api.mutations, 1);
});

Deno.test("follow accepts an absent legacy matrix index only after a successful lookup", async () => {
  const api = new FollowFake();
  const result = await api.follow();
  assert.equal(result.journal.decision, "advanced");
  assert.equal(api.mutations, 1);
  assert.ok(api.requests.some((request) => indexLookup(new URL(request.url))));
});

Deno.test("follow refuses incomplete or ambiguous matrix index reference evidence", async (t) => {
  for (const failure of ["paginated", "duplicate", "invalid row"] as const) {
    await t.step(failure, async () => {
      const api = settledWave();
      api.intercept = (_request, url) => {
        if (!indexLookup(url)) return;
        const ref = {
          ref: "refs/heads/sentinel-state/maintenance-index",
          object: { type: "commit", sha: "6".repeat(40) },
        };
        if (failure === "duplicate") return response([ref, ref]);
        if (failure === "invalid row") return response([{}]);
        return response(
          [],
          200,
          new Headers({
            link: '<https://api.github.com/next?page=2>; rel="next"',
          }),
        );
      };
      const result = await api.follow();
      assert.equal(result.journal.reason, "matrix_wave_unreadable");
      assert.equal(api.mutations, 0);
    });
  }
});
