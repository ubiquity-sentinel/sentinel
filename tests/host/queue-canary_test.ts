import assert from "node:assert/strict";
import { CANARY_BRANCH, CANARY_GRANTS } from "../../ops/queue-canary-pins.ts";
import { canaryBindingDigest, runQueueCanary } from "../../ops/queue-canary.ts";
import { sanitizedCanaryArtifact } from "../../ops/queue-canary-main.ts";
import {
  ACTOR,
  GRANT,
  rig,
  SHA1,
  SHA2,
  SHA3,
  T0,
} from "./queue-canary-fixtures.ts";

Deno.test("canary fixture heads coexist with the fixed base and legacy heads refuse effects", async () => {
  const r = await rig();
  r.host.action = "preflight";
  assert.equal(r.grants[0].pull.baseRef, CANARY_BRANCH);
  assert(!r.grants[0].pull.headRef.startsWith(`${CANARY_BRANCH}/`));
  assert.equal((await runQueueCanary(r)).status, "observed");
  r.grants[0].pull.headRef = "queue-canary/no-rule";
  assert.equal((await runQueueCanary(r)).reason, "invalid_source_grant");
  assert(!r.events.includes("enqueue"));
  assert(!r.events.includes("dequeue"));
});

Deno.test("canary ships without source grants; inputs cannot activate an effect", async () => {
  assert.deepEqual(CANARY_GRANTS, []);
  const r = await rig();
  const result = await runQueueCanary({ ...r, grants: CANARY_GRANTS });
  assert.equal(result.reason, "source_grant_missing");
  assert(!r.events.includes("enqueue"));
});
Deno.test("canary rejects wrong source, ref, identity, attempt and PR scope before an effect", async (t) => {
  for (
    const field of [
      "ref",
      "sha",
      "workflowSha",
      "expectedSha",
      "repository",
      "event",
      "mintedAppSlug",
    ] as const
  ) {
    await t.step(field, async () => {
      const r = await rig();
      r.host[field] = "wrong";
      assert.equal((await runQueueCanary(r)).reason, "invalid_host");
      assert(!r.events.includes("enqueue"));
    });
  }
  for (
    const mutate of [
      (r: Awaited<ReturnType<typeof rig>>) => {
        r.host.attempt = 2;
      },
      (r: Awaited<ReturnType<typeof rig>>) => {
        r.grants[0].pull.baseRef = "development";
      },
      (r: Awaited<ReturnType<typeof rig>>) => {
        r.grants[0].pull.repository = {
          ...GRANT.pull.repository,
          name: "sentinel",
        };
      },
      (r: Awaited<ReturnType<typeof rig>>) => {
        r.grants[0].pull.head = SHA1;
      },
    ]
  ) {
    const r = await rig();
    mutate(r);
    await runQueueCanary(r);
    assert(!r.events.includes("enqueue"));
  }
});
Deno.test("canary retains intent before one ambiguous submission; observation never retries", async () => {
  const r = await rig();
  const result = await runQueueCanary(r);
  assert.equal(result.status, "ambiguous");
  assert.equal(r.events.filter((event) => event === "enqueue").length, 1);
  assert(
    r.events.indexOf("retain:effect_intent_retained") <
      r.events.indexOf("enqueue"),
  );
  assert.equal(result.productionDeliveryProof, false);
  r.host.action = "observe";
  const resumed = await runQueueCanary(r);
  assert.equal(resumed.status, "observed");
  assert.equal(r.events.filter((event) => event === "enqueue").length, 1);
});
Deno.test("earlier failed dispatch or unavailable history consumes one-shot authority", async () => {
  const r = await rig();
  r.port.firstDispatch = () => Promise.resolve(false);
  assert.equal(
    (await runQueueCanary(r)).reason,
    "one_shot_already_consumed_or_unavailable",
  );
  assert(!r.events.includes("enqueue"));
  const renamed = structuredClone(GRANT);
  renamed.pull.headRef = "queue-canary-fixtures/renamed";
  assert.equal(
    await canaryBindingDigest(renamed),
    await canaryBindingDigest(GRANT),
  );
});
Deno.test("prior native events, red CI, rule drift, and unavailable queue forbid initial enqueue", async (t) => {
  for (
    const reason of [
      "events",
      "ci",
      "workflow",
      "rules",
      "unavailable",
    ] as const
  ) {
    await t.step(reason, async () => {
      const r = await rig();
      if (reason === "events" && r.observed.events.status === "complete") {
        r.observed.events.value.added = [{ id: "old", at: T0, actor: ACTOR }];
      }
      if (reason === "ci") r.observed.headCiGreen = false;
      if (reason === "workflow") r.observed.workflowAccepted = false;
      if (reason === "rules") r.observed.rulesAccepted = false;
      if (reason === "unavailable") {
        r.observed.queue = { status: "unavailable", reason: "permission" };
      }
      await runQueueCanary(r);
      assert(!r.events.includes("enqueue"));
    });
  }
});
Deno.test("late native membership and deadline revoke submission before retained intent", async (t) => {
  for (const late of ["member", "deadline"] as const) {
    await t.step(late, async () => {
      const r = await rig();
      let count = 0;
      r.port.observe = () => {
        count++;
        const next = structuredClone(r.observed);
        if (
          count === 2 && late === "member" &&
          next.membership.status === "complete"
        ) next.membership.value.mergedRevision = SHA3;
        if (count === 2 && late === "deadline") r.advance(285_001);
        return Promise.resolve(next);
      };
      assert.equal(
        (await runQueueCanary(r)).reason,
        "pre_effect_drift_or_deadline",
      );
      assert(!r.events.includes("enqueue"));
    });
  }
});
Deno.test("owned dequeue requires exact source-reviewed artifact and native App entry", async () => {
  const r = await rig();
  r.host.action = "dequeue";
  const entry = {
    id: "ENTRY_CANARY",
    pull: GRANT.pull,
    position: 1,
    state: "QUEUED" as const,
    enqueuer: ACTOR,
    enqueuedAt: T0,
    baseCommit: SHA1,
    headCommit: SHA2,
    jump: false,
    solo: false,
  };
  r.grants[0].prior = {
    runId: 300,
    sourceSha: SHA3,
    requestDigest: "d".repeat(64),
    artifactId: 555,
    artifactDigest: "e".repeat(64),
    entryId: entry.id,
    requestId: null,
  };
  if (r.observed.queue.status === "complete") {
    r.observed.queue.value.entries = [entry];
  }
  if (r.observed.membership.status === "complete") {
    r.observed.membership.value.entry = entry;
  }
  r.port.priorAccepted = () => Promise.resolve(false);
  assert.equal(
    (await runQueueCanary(r)).reason,
    "owned_entry_provenance_unavailable",
  );
  assert(!r.events.includes("dequeue"));
  r.port.priorAccepted = () => Promise.resolve(true);
  assert.equal((await runQueueCanary(r)).status, "ambiguous");
  assert.equal(r.events.filter((event) => event === "dequeue").length, 1);
});
Deno.test("native exceptions cannot expose tokens; artifact redaction is explicit", async () => {
  const r = await rig();
  r.port.enqueueCanary = () =>
    Promise.reject(new Error("Bearer synthetic-private-value"));
  const result = await runQueueCanary(r);
  assert.equal(result.reason, "effect_outcome_unknown");
  assert(!JSON.stringify(result).includes("synthetic-private-value"));
  assert.deepEqual(
    sanitizedCanaryArtifact({ reason: "token=synthetic-private-value" }),
    { reason: { omitted: "unsafe_text" } },
  );
});

Deno.test("canary workflow is dispatch-only, uses existing App identity, and caps the child", async () => {
  const source = await Deno.readTextFile(
    new URL("../../.github/workflows/queue-canary.yml", import.meta.url),
  );
  assert(source.includes("workflow_dispatch:"));
  assert(!/^ {2}(push|pull_request|schedule):/m.test(source));
  assert(source.includes("app-id: 4682172"));
  assert(source.includes("repositories: ai.ubq.fi"));
  assert(source.includes("secrets.SENTINEL_SUPERVISOR_APP_PRIVATE_KEY"));
  assert(source.includes("timeout --kill-after=5s 290s"));
  assert(source.includes("persist-credentials: false"));
  assert(!source.includes("--allow-run"));
  assert(source.includes("refs/heads/sentinel-supervisor"));
});
