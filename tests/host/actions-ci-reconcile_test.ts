/** Hosted actions-ci-reconcile_test responsibility. */
import assert from "node:assert/strict";
import {
  API_BASE,
  APPROVE_PATH,
  candidateRecord,
  incompleteCandidateRecord,
  LIST_PATH,
  makeRig,
  PULL_PATH,
  pullBody,
  response,
  RUN_ID,
  RUN_PATH,
  runBody,
  runsBody,
} from "./actions-ci-fixture.ts";

Deno.test(
  "ci approval: a later invocation observing a queued run never submits again",
  async () => {
    const rig = makeRig();
    const first = await rig.run();
    assert.deepEqual(first, { approved: 1, pending: 0, unavailable: 0 });
    // The same candidate still lists the run, but GitHub now reports it queued
    // (no longer awaiting approval): observation only, never a second POST.
    rig.http.on(
      "GET",
      LIST_PATH,
      () =>
        response(
          200,
          runsBody([runBody({ status: "queued", conclusion: null })]),
        ),
    );
    const second = await rig.run();
    assert.deepEqual(second, { approved: 0, pending: 1, unavailable: 0 });
    assert.equal(rig.http.posts().length, 1, "no second approval POST");
  },
);

Deno.test(
  "ci approval: a lost approval response reconciles without a duplicate POST",
  async () => {
    const reconciled = makeRig();
    reconciled.http.on(
      "POST",
      APPROVE_PATH,
      () => Promise.reject(new Error("connection reset")),
    );
    let runReads = 0;
    reconciled.http.on("GET", RUN_PATH, () => {
      runReads++;
      return response(
        200,
        runReads === 1
          ? runBody()
          : runBody({ status: "queued", conclusion: null }),
      );
    });
    assert.deepEqual(
      await reconciled.run(),
      { approved: 1, pending: 0, unavailable: 0 },
    );
    assert.equal(reconciled.http.posts().length, 1, "exactly one POST");
    assert.equal(runReads, 2, "the same run was re-read to reconcile");

    const unresolved = makeRig();
    unresolved.http.on(
      "POST",
      APPROVE_PATH,
      () => Promise.reject(new Error("connection reset")),
    );
    assert.deepEqual(
      await unresolved.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(
      unresolved.http.posts().length,
      1,
      "no duplicate POST after a lost response",
    );
  },
);

Deno.test(
  "ci approval: cooldown denial sends no HTTP and an observed 429 is recorded",
  async () => {
    const denied = makeRig();
    denied.gate.deny = true;
    assert.deepEqual(
      await denied.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(denied.http.calls.length, 0, "no HTTP while cooling down");
    assert.deepEqual(denied.gate.admissions, [0]);

    const limited = makeRig();
    limited.http.on(
      "GET",
      PULL_PATH,
      () => response(429, "", { "retry-after": "3600" }),
    );
    assert.deepEqual(
      await limited.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(limited.gate.recorded.length, 1, "the 429 is recorded");
    assert.equal(limited.http.posts().length, 0);
  },
);

Deno.test(
  "ci approval: a malformed, unbounded, linked or ambiguous run list never submits",
  async () => {
    const bounded = makeRig();
    bounded.http.on(
      "GET",
      LIST_PATH,
      () => response(200, runsBody([runBody()], 101)),
    );
    assert.deepEqual(
      await bounded.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(bounded.http.posts().length, 0);

    const linked = makeRig();
    linked.http.on(
      "GET",
      LIST_PATH,
      () =>
        response(200, runsBody([runBody()]), {
          link: `<${API_BASE}${LIST_PATH}?page=2>; rel="next"`,
        }),
    );
    assert.deepEqual(
      await linked.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(linked.http.posts().length, 0);

    const malformed = makeRig();
    malformed.http.on("GET", LIST_PATH, () => response(200, "{not json"));
    assert.deepEqual(
      await malformed.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(malformed.http.posts().length, 0);

    const ambiguous = makeRig();
    ambiguous.http.on(
      "GET",
      LIST_PATH,
      () =>
        response(
          200,
          runsBody([runBody({ id: RUN_ID }), runBody({ id: RUN_ID + 1 })]),
        ),
    );
    assert.deepEqual(
      await ambiguous.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(
      ambiguous.http.posts().length,
      0,
      "ambiguous runs never submit",
    );
  },
);

Deno.test(
  "ci approval: a wrong exact-run id or changed attempt never submits or reports approval",
  async () => {
    const wrongId = makeRig();
    wrongId.http.on(
      "GET",
      RUN_PATH,
      () => response(200, runBody({ id: RUN_ID + 1 })),
    );
    assert.deepEqual(
      await wrongId.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(wrongId.http.posts().length, 0);

    const changedAttempt = makeRig();
    changedAttempt.http.on(
      "GET",
      RUN_PATH,
      () => response(200, runBody({ attempt: 2 })),
    );
    assert.deepEqual(
      await changedAttempt.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(changedAttempt.http.posts().length, 0);

    // A lost POST whose reconciliation read returns a different attempt must
    // never be reported as an approval, and never POST twice.
    const lostAttempt = makeRig();
    lostAttempt.http.on(
      "POST",
      APPROVE_PATH,
      () => Promise.reject(new Error("connection reset")),
    );
    let reads = 0;
    lostAttempt.http.on("GET", RUN_PATH, () => {
      reads++;
      return response(
        200,
        reads === 1
          ? runBody()
          : runBody({ attempt: 2, status: "queued", conclusion: null }),
      );
    });
    assert.deepEqual(
      await lostAttempt.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(lostAttempt.http.posts().length, 1, "one POST, never two");
    assert.equal(reads, 2, "the reconciliation read ran for the same run");
  },
);

Deno.test(
  "ci approval: incomplete unpublished candidates never reach approval",
  async () => {
    const incomplete = [0, 1, 2].map(incompleteCandidateRecord);
    // The valid candidate is LAST; incomplete records must never reach the API.
    const rig = makeRig([...incomplete, candidateRecord()]);
    let incompletePrReads = 0;
    for (const record of incomplete) {
      const pr = record.target.pr as number;
      const head = record.target.head as string;
      const headRef = record.target.branch as string;
      rig.http.on(
        "GET",
        `/repos/ubiquity-sentinel/sentinel/pulls/${pr}`,
        () => {
          incompletePrReads++;
          return response(
            200,
            pullBody({ number: pr, headSha: head, headRef }),
          );
        },
      );
    }
    const summary = await rig.run();
    assert.deepEqual(summary, { approved: 1, pending: 0, unavailable: 0 });
    assert.equal(incompletePrReads, 0, "no API call for an incomplete PR");
    assert.equal(rig.http.posts().length, 1, "one approval POST");
    assert.equal(
      new URL(rig.http.posts()[0]!.url).pathname,
      APPROVE_PATH,
      "the valid candidate is approved",
    );
    assert.deepEqual(
      rig.http.calls.map((call) =>
        `${call.method} ${new URL(call.url).pathname}`
      ),
      [
        `GET ${PULL_PATH}`,
        `GET ${LIST_PATH}`,
        `GET ${RUN_PATH}`,
        `GET ${PULL_PATH}`,
        `POST ${APPROVE_PATH}`,
      ],
      "exactly the valid fourth record is read and approved",
    );
  },
);
