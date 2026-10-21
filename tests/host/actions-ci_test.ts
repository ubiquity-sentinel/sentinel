/** Hosted actions-ci_test responsibility. */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";
import {
  APP_PUBLISHER,
  APPROVE_PATH,
  candidateRecord,
  incompleteCandidateRecord,
  LIST_PATH,
  makeRig,
  PR_NUMBER,
  PUBLISHER,
  PULL_PATH,
  pullBody,
  REPO_ID,
  response,
  RUN_ID,
  RUN_PATH,
  runBody,
  runsBody,
} from "./actions-ci-fixture.ts";
import type { RigV1 } from "./actions-ci-fixture.ts";

Deno.test(
  "ci approval: absolute deadline stops candidates and recomputes every request bound",
  async () => {
    const expired = makeRig();
    assert.deepEqual(await expired.run(expired.clock.now()), {
      approved: 0,
      pending: 0,
      unavailable: 1,
    });
    assert.equal(expired.http.calls.length, 0);

    const rig = makeRig();
    const advance = (body: unknown) => {
      rig.clock.advance(1000);
      return response(200, body);
    };
    rig.http.on("GET", PULL_PATH, () => advance(pullBody()));
    rig.http.on("GET", LIST_PATH, () => advance(runsBody([runBody()])));
    rig.http.on("GET", RUN_PATH, () => advance(runBody()));
    assert.deepEqual(await rig.run(T0 + 3500), {
      approved: 0,
      pending: 0,
      unavailable: 1,
    });
    assert.equal(
      rig.http.posts().length,
      0,
      "expiry before approval never submits",
    );
    assert.deepEqual(
      rig.http.calls.map((call) =>
        (call as HttpRequestV1 & { deadlineMs?: number }).deadlineMs
      ),
      [3500, 2500, 1500, 500],
    );

    const late = candidateRecord({
      id: "late-deadline-candidate",
      target: {
        base: SHA1,
        branch: "sentinel/repair/late-deadline",
        checkpoint: null,
        head: SHA2,
        pr: PR_NUMBER + 1,
        candidateState: {
          preserved: {
            operationKey: `impl:${"ef".repeat(32)}`,
            base: SHA1,
            head: SHA2,
            ref: `refs/heads/sentinel-candidates/${"ef".repeat(32)}`,
          },
          publishedHead: SHA2,
        },
      },
    });
    const candidates = makeRig([candidateRecord(), late]);
    candidates.http.on("POST", APPROVE_PATH, () => {
      candidates.clock.advance(5000);
      return response(201, {});
    });
    assert.deepEqual(await candidates.run(T0 + 5000), {
      approved: 1,
      pending: 0,
      unavailable: 1,
    });
    assert.equal(
      candidates.http.calls.length,
      5,
      "no request starts for a later expired candidate",
    );
    assert.equal(candidates.http.posts().length, 1);

    const delayedGate = makeRig();
    delayedGate.gate.beforeRequest = (installationId) => {
      delayedGate.gate.admissions.push(installationId);
      delayedGate.clock.advance(4000);
      return Promise.resolve(portOk(undefined));
    };
    assert.deepEqual(await delayedGate.run(T0 + 3500), {
      approved: 0,
      pending: 0,
      unavailable: 1,
    });
    assert.equal(
      delayedGate.http.calls.length,
      0,
      "a late gate resolution cannot start HTTP",
    );
  },
);

Deno.test(
  "ci approval: all five durable candidates progress and repeated approval is idempotent",
  async () => {
    const work = Array.from({ length: 5 }, (_, index) => {
      const identity = (index + 4).toString(16);
      const head = identity.repeat(40);
      const reservation = identity.repeat(64);
      return candidateRecord({
        id: `uncapped-ci-${index}`,
        source: { kind: "issue", id: `${200 + index}`, revision: SHA1 },
        related: { incidentId: null, issueNumber: 200 + index },
        target: {
          base: SHA1,
          branch: `sentinel/repair/uncapped-ci-${index}`,
          checkpoint: null,
          head,
          pr: 50 + index,
          candidateState: {
            preserved: {
              operationKey: `impl:${reservation}`,
              base: SHA1,
              head,
              ref: `refs/heads/sentinel-candidates/${reservation}`,
            },
            publishedHead: head,
          },
        },
      });
    });
    const rig = makeRig([
      ...Array.from(
        { length: 4 },
        (_, index) => incompleteCandidateRecord(index),
      ),
      ...work,
    ]);
    const approvedRuns = new Set<number>();
    const runFor = (index: number) => {
      const record = work[index]!;
      return runBody({
        id: RUN_ID + index,
        headSha: record.target.head!,
        headRef: record.target.branch!,
        prNumber: record.target.pr!,
      });
    };
    for (const [index, record] of work.entries()) {
      rig.http.on(
        "GET",
        `/repos/Ubiquity-Sentinel/sentinel/pulls/${record.target.pr}`,
        () =>
          response(
            200,
            pullBody({
              number: record.target.pr!,
              headSha: record.target.head!,
              headRef: record.target.branch!,
            }),
          ),
      );
      rig.http.on(
        "GET",
        `/repos/Ubiquity-Sentinel/sentinel/actions/runs/${RUN_ID + index}`,
        () => response(200, runFor(index)),
      );
      rig.http.on(
        "POST",
        `/repos/Ubiquity-Sentinel/sentinel/actions/runs/${
          RUN_ID + index
        }/approve`,
        () => {
          approvedRuns.add(RUN_ID + index);
          return response(201, {});
        },
      );
    }
    rig.http.on("GET", LIST_PATH, (request) => {
      const head = new URL(request.url).searchParams.get("head_sha");
      const index = work.findIndex((record) => record.target.head === head);
      assert.ok(index >= 0, "the list query binds to one eligible exact head");
      return response(
        200,
        runsBody(approvedRuns.has(RUN_ID + index) ? [] : [runFor(index)]),
      );
    });

    assert.deepEqual(await rig.run(), {
      approved: 5,
      pending: 0,
      unavailable: 0,
    });
    assert.deepEqual([...approvedRuns], work.map((_, index) => RUN_ID + index));
    assert.equal(
      rig.http.posts().length,
      5,
      "one POST for each distinct approved run",
    );
    assert.deepEqual(await rig.run(), {
      approved: 0,
      pending: 5,
      unavailable: 0,
    });
    assert.equal(
      rig.http.posts().length,
      5,
      "the next pass observes already approved runs",
    );
    assert.ok(
      rig.http.calls.every((call) =>
        call.headers.get("authorization") === "Bearer dummy-token"
      ),
    );
  },
);

Deno.test(
  "ci approval: approves the single exact own action_required run",
  async () => {
    const rig = makeRig();
    const summary = await rig.run();
    assert.deepEqual(summary, { approved: 1, pending: 0, unavailable: 0 });
    assert.equal(rig.http.posts().length, 1);
    assert.equal(new URL(rig.http.posts()[0]!.url).pathname, APPROVE_PATH);
    // Read-only identity reads precede the single POST: PR, bounded list,
    // exact run, exact PR again, then the approval.
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
    );
  },
);

Deno.test(
  "ci approval: a pull request and run published by the sentinel App are approved during the transition",
  async () => {
    for (const login of [PUBLISHER, APP_PUBLISHER]) {
      const rig = makeRig();
      rig.http.on(
        "GET",
        PULL_PATH,
        () => response(200, pullBody({ author: login })),
      );
      rig.http.on(
        "GET",
        LIST_PATH,
        () =>
          response(
            200,
            runsBody([runBody({ actor: login, triggeringActor: login })]),
          ),
      );
      rig.http.on(
        "GET",
        RUN_PATH,
        () => response(200, runBody({ actor: login, triggeringActor: login })),
      );
      const summary = await rig.run();
      assert.deepEqual(
        summary,
        { approved: 1, pending: 0, unavailable: 0 },
        login,
      );
      assert.equal(rig.http.posts().length, 1, login);
      assert.equal(
        new URL(rig.http.posts()[0]!.url).pathname,
        APPROVE_PATH,
        login,
      );
    }
  },
);

Deno.test(
  "ci approval: wrong head, actor, repo, workflow, PR association or moved PR never submits",
  async () => {
    const cases: Array<{ name: string; script: (rig: RigV1) => void }> = [
      {
        name: "wrong run head",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () => response(200, runsBody([runBody({ headSha: SHA1 })])),
          ),
      },
      {
        name: "wrong actor",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () => response(200, runsBody([runBody({ actor: "octocat" })])),
          ),
      },
      {
        name: "foreign repository",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([runBody({ headRepo: "attacker/sentinel" })]),
              ),
          ),
      },
      {
        name: "wrong workflow",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([runBody({ path: ".github/workflows/other.yml" })]),
              ),
          ),
      },
      {
        name: "wrong PR association",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () => response(200, runsBody([runBody({ prNumber: 31 })])),
          ),
      },
      {
        name: "association repository id",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([runBody({ assocRepoId: REPO_ID + 1 })]),
              ),
          ),
      },
      {
        name: "association repository name",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([runBody({ assocRepoName: "other" })]),
              ),
          ),
      },
      {
        name: "association repository url",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([
                  runBody({
                    assocRepoUrl:
                      "https://api.github.com/repos/attacker/sentinel",
                  }),
                ]),
              ),
          ),
      },
      {
        name: "raw PR repository id disagreement",
        script: (rig) =>
          rig.http.on(
            "GET",
            PULL_PATH,
            () => response(200, pullBody({ headRepoId: REPO_ID + 1 })),
          ),
      },
      {
        name: "closed PR",
        script: (rig) =>
          rig.http.on(
            "GET",
            PULL_PATH,
            () => response(200, pullBody({ state: "closed" })),
          ),
      },
      {
        name: "moved current PR",
        script: (rig) => {
          let reads = 0;
          rig.http.on("GET", PULL_PATH, () => {
            reads++;
            return response(
              200,
              reads === 1 ? pullBody() : pullBody({ headSha: SHA1 }),
            );
          });
        },
      },
    ];
    for (const testCase of cases) {
      const rig = makeRig();
      testCase.script(rig);
      const summary = await rig.run();
      assert.deepEqual(
        summary,
        { approved: 0, pending: 0, unavailable: 1 },
        testCase.name,
      );
      assert.equal(
        rig.http.posts().length,
        0,
        `${testCase.name}: no approval POST`,
      );
    }
  },
);
