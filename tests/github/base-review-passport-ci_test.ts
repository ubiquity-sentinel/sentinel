/** The production base-review CI consumer; no network, credential or native call. */
import assert from "node:assert/strict";
import { B, commitFile, H, key, result } from "./backup-ci-fixtures.ts";
import { rawRun, RUN, startedJob } from "./backup-ci-consumer-fixtures.ts";
import { decideCiGate } from "../../src/repair/loop-checks.ts";
import { passportCiFixture } from "./base-review-passport-fixtures.ts";

Deno.test("Passport base CI: verified exact-tree backup stands in for a proven never-started job", async () => {
  const h = passportCiFixture();
  const read = await h.client.readBaseReviewChecks(H, ["deno"]);
  assert.ok(read.ok);
  assert.equal(read.value.checks[0].conclusion, "success");
  assert.ok(read.value.checks[0].backup);
  assert.equal(h.reader.reads.length, 1);
});

Deno.test("Passport base CI: exact native push coverage works without backup capability", async () => {
  const h = passportCiFixture(H, true, null);
  const read = await h.client.readBaseReviewChecks(H, ["deno"]);
  assert.ok(read.ok);
  assert.equal(read.value.checks[0].conclusion, "success");
  assert.equal(read.value.checks[0].backup, undefined);
  assert.equal(h.reader.reads.length, 0);
});

type Fixture = ReturnType<typeof passportCiFixture>;
const rejectedPassportCi: [string, (h: Fixture) => void][] = [
  ["absent CI", (h) => h.data.checks = []],
  [
    "foreign app",
    (h) => h.data.checks[0].app = { id: 99, slug: "github-actions" },
  ],
  ["foreign head", (h) => h.data.checks[0].head_sha = B],
  ["unknown suite", (h) => h.data.checks[0].check_suite = { id: 99 }],
  [
    "wrong workflow",
    (h) => h.data.runs[0].path = ".github/workflows/other.yml",
  ],
  ["wrong run head", (h) => h.data.runs[0].head_sha = B],
  [
    "wrong run repository",
    (h) => h.data.runs[0].repository = { full_name: "fork/passport.ubq.fi" },
  ],
  [
    "wrong execution tree",
    (h) => h.data.runs[0].head_commit = { id: H, tree_id: B },
  ],
  ["unknown event", (h) => h.data.runs[0].event = "workflow_dispatch"],
  ["missing job coverage", (h) => h.data.jobs = []],
  [
    "extra job coverage",
    (h) => h.data.jobs.push({ ...h.data.jobs[0], id: RUN + 1, name: "other" }),
  ],
  ["wrong job", (h) => h.data.jobs[0].id = RUN + 1],
  ["wrong job name", (h) => h.data.jobs[0].name = "other"],
  ["wrong job run", (h) => h.data.jobs[0].run_id = 99],
  ["wrong job head", (h) => h.data.jobs[0].head_sha = B],
  ["missing source", (h) => h.data.tree.tree = []],
  ["unknown source", (h) => h.data.tree.truncated = true],
  ["wrong source tree", (h) => h.data.tree.sha = B],
  ["wrong base object", (h) => h.data.commit.sha = B],
  ["missing base", (h) => h.data.missing.add(`/git/commits/${H}`)],
  [
    "unavailable store",
    (h) => h.data.store = { kind: "unavailable", detail: "offline" },
  ],
  ["absent store", (h) => {
    assert.equal(h.data.store.kind, "ok");
    if (h.data.store.kind === "ok") h.data.store.file = null;
  }],
  ["unverified calibration", (h) => {
    if (h.data.store.kind === "ok") h.data.store.calibration = null;
  }],
  ["real red job", (h) => {
    h.data.jobs[0].steps = [{ number: 1, name: "test", status: "completed" }];
    h.data.jobs[0].runner_id = 4;
  }],
  ["unknown no-start", (h) => {
    h.data.jobs[0].steps = undefined as never;
  }],
  ["same-name commit status", (h) => h.data.statuses = [{ context: "deno" }]],
  ["unknown status contexts", (h) => h.data.statuses = [{}]],
  [
    "unknown earlier no-start",
    (h) => h.data.all = [...h.data.checks, rawRun(RUN - 1)],
  ],
  ["foreign earlier producer", (h) =>
    h.data.all = [
      ...h.data.checks,
      rawRun(RUN - 1, { app: { id: 99, slug: "github-actions" } }),
    ]],
];

rejectedPassportCi.push(["an earlier job actually ran and failed", (h) => {
  h.data.all = [...h.data.checks, rawRun(RUN - 1)];
  h.data.historicalJobs.set(RUN - 1, startedJob(RUN - 1));
}]);

const invalidStore: [string, (file: ReturnType<typeof commitFile>) => void][] =
  [
    ["wrong store commit", (f) => f.commit = B],
    ["wrong store repository", (f) => f.repository.id++],
    ["empty workflow policy", (f) => f.workflows = []],
    ["unsupported workflow policy", (f) => f.workflows[0].supported = false],
    ["empty job policy", (f) => f.workflows[0].expected = []],
    ["incomplete job policy", (f) => f.workflows[0].expected.push("other")],
    ["wrong workflow source", (f) => f.workflows[0].blob = B],
    [
      "wrong workflow path",
      (f) => f.workflows[0].path = ".github/workflows/other.yml",
    ],
  ];
for (const [label, mutate] of invalidStore) {
  rejectedPassportCi.push([label, (h) => {
    assert.ok(h.data.store.kind === "ok" && h.data.store.file);
    mutate(h.data.store.file);
  }]);
}
for (
  const [label, mutate] of [
    ["wrong backup tree", (e) => e.binding.tree = B],
    ["untrusted backup producer", (e) => e.runnerId = "0".repeat(16)],
    ["wrong backup source", (e) => e.binding.workflowBlob = B],
    ["wrong backup execution", (e) => e.binding.execCommit = B],
    ["wrong backup parent", (e) => e.binding.parents = [H]],
    ["wrong backup job", (e) => e.binding.jobKey = "other"],
    ["wrong backup matrix", (e) => e.binding.matrix = { other: true }],
    [
      "wrong backup workflow",
      (e) => e.key.workflowPath = ".github/workflows/other.yml",
    ],
    ["red backup", (e) => e.conclusion = "failure"],
  ] satisfies [string, (entry: ReturnType<typeof result>) => void][]
) {
  rejectedPassportCi.push([label, (h) => {
    const entry = result();
    mutate(entry);
    assert.ok(h.data.store.kind === "ok");
    h.data.store.file = commitFile([entry]);
  }]);
}

Deno.test("Passport base CI: missing, unknown, red or mismatched evidence cannot pass", async (t) => {
  for (const [label, mutate] of rejectedPassportCi) {
    await t.step(label, async () => {
      const h = passportCiFixture();
      mutate(h);
      const read = await h.client.readBaseReviewChecks(H, ["deno"]);
      assert.ok(
        !read.ok || decideCiGate(read.value.checks) !== "proceed",
        label,
      );
    });
  }
});

Deno.test("Passport base CI: native evidence must cover this push tree and the complete policy", async () => {
  for (const names of [[], ["other"], ["deno", "other"]]) {
    const h = passportCiFixture(H, true);
    assert.equal((await h.client.readBaseReviewChecks(H, names)).ok, false);
  }
  const h = passportCiFixture(H, true);
  h.data.runs[0].event = "pull_request";
  assert.equal((await h.client.readBaseReviewChecks(H, ["deno"])).ok, false);
});

Deno.test("Passport base CI: equivalent PR backup is allowed, shadow/off/raw billing no-start are not green", async () => {
  const h = passportCiFixture();
  assert.ok(h.data.store.kind === "ok");
  h.data.store.file = commitFile([result(key({ context: "pull_request" }))]);
  const read = await h.client.readBaseReviewChecks(H, ["deno"]);
  assert.ok(read.ok);
  assert.equal(decideCiGate(read.value.checks), "proceed");
  for (const mode of ["shadow", "off", null] as const) {
    const h = passportCiFixture(H, false, mode);
    const read = await h.client.readBaseReviewChecks(H, ["deno"]);
    assert.ok(read.ok);
    assert.notEqual(decideCiGate(read.value.checks), "proceed");
    assert.equal(read.value.checks[0].backup, undefined);
  }
});

Deno.test("Passport base CI: a real native failure is never substituted and a success must have run", async () => {
  const h = passportCiFixture();
  h.data.jobs[0].steps = [{ number: 1, name: "test", status: "completed" }];
  h.data.jobs[0].runner_id = 4;
  const read = await h.client.readBaseReviewChecks(H, ["deno"]);
  assert.ok(read.ok);
  assert.equal(read.value.checks[0].conclusion, "failure");
  assert.equal(read.value.checks[0].backup, undefined);
  assert.equal(h.reader.reads.length, 0);
  const empty = passportCiFixture(H, true);
  empty.data.jobs[0].steps = [];
  empty.data.jobs[0].runner_id = 0;
  assert.equal(
    (await empty.client.readBaseReviewChecks(H, ["deno"])).ok,
    false,
  );
});

Deno.test("Passport base CI: target-skipped and neutral native jobs remain not red", async () => {
  for (const conclusion of ["skipped", "neutral"]) {
    const h = passportCiFixture(H, true);
    h.data.checks[0].conclusion = conclusion;
    h.data.jobs[0].conclusion = conclusion;
    h.data.jobs[0].steps = [];
    h.data.jobs[0].runner_id = 0;
    const read = await h.client.readBaseReviewChecks(H, ["deno"]);
    assert.ok(read.ok);
    assert.equal(decideCiGate(read.value.checks), "proceed");
    assert.equal(h.reader.reads.length, 0);
  }
});
