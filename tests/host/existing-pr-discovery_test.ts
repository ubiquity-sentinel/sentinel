import assert from "node:assert/strict";
import { EXISTING_PR_TAKEOVER_ACTIVATED } from "../../src/github/existing-pr-takeover-policy.ts";
import { explicitPullReferences } from "../../src/host/existing-pr-discovery.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-task-acceptance.ts";
import { discoveryRig } from "./existing-pr-discovery-fixtures.ts";
import { REPO, SHA1, SHA2, SHA3 } from "../state/helpers.ts";

Deno.test("takeover discovery uses native HTTP association while source activation stays false", async () => {
  const r = discoveryRig();
  assert.equal(EXISTING_PR_TAKEOVER_ACTIVATED, false);
  const result = await r.discover();
  assert.equal(result.status, "candidate");
  if (result.status !== "candidate") return;
  assert.equal(result.candidate.binding.pullRequest, 7);
  assert.equal(result.candidate.binding.author, "ubiquity-sentinel[bot]");
  assert.equal(result.candidate.binding.issueNodeId, "I_1");
  assert.equal(result.candidate.binding.pullNodeId, "PR_7");
  assert.equal(result.candidate.binding.headRef, "human/issue-1");
  assert.equal(
    result.candidate.binding.issueDigest,
    await reviewTaskStatementDigest({
      issueNumber: 1,
      title: r.source.issue.title,
      body: r.source.issue.body,
    }),
  );
  assert.equal(result.candidate.head, SHA2);
  assert.equal(result.candidate.base, SHA1);
  assert.equal(result.candidate.associated, true);
  assert.equal(result.candidate.reciprocalComplete, true);
  assert.ok(r.requests.length >= 5);
  assert.equal(r.auth.calls, r.requests.length);
  assert.ok(
    r.requests.every((request) =>
      request.method === "GET" ||
      (request.method === "POST" && request.url.endsWith("/graphql"))
    ),
  );
  assert.equal(r.record.target.pr, null, "discovery writes no custody");
});

Deno.test("takeover discovery deduplicates native and explicit references and accepts either native-only or both", async (t) => {
  for (
    const body of [
      "",
      "PR #7",
      "pull request #7",
      "https://github.com/ubiquity/ai.ubq.fi/pull/7",
      "PR #7 and https://github.com/ubiquity/ai.ubq.fi/pull/7/files",
    ]
  ) {
    await t.step(body || "native only", async () => {
      const r = discoveryRig();
      r.source.issue.body = body;
      assert.equal((await r.discover()).status, "candidate");
      assert.equal(r.count.rest, 2);
    });
  }
});

Deno.test("takeover discovery explicit-only links park, bare issue text grants nothing, and complete absence is reread", async () => {
  const explicit = discoveryRig();
  explicit.source.pulls = [];
  explicit.source.issue.body = "PR #7";
  assert.deepEqual(await explicit.discover(), {
    status: "owner_park",
    reason: "association_unproven",
    prNumbers: [7],
  });
  const absent = discoveryRig();
  absent.source.pulls = [];
  absent.source.issue.body =
    "See #7 and https://github.com/ubiquity/ai.ubq.fi/issues/7";
  const result = await absent.discover();
  assert.equal(result.status, "none");
  assert.equal(absent.count.source, 2);
  assert.equal(absent.count.rest, 0);
});

Deno.test("takeover discovery counts the native-plus-explicit union before taking any branch", async () => {
  const r = discoveryRig();
  r.source.issue.body = "PR #8";
  const other = structuredClone(r.pull);
  other.number = 8;
  other.nodeId = "PR_8";
  r.extraPulls.set(8, other);
  const result = await r.discover();
  assert.equal(result.status, "owner_park");
  if (result.status === "owner_park") {
    assert.equal(result.reason, "ambiguous");
    assert.deepEqual([...result.prNumbers].sort(), [7, 8]);
  }
  assert.ok(!r.calls.includes("git"));
  assert.ok(!r.calls.includes("queue"));
});

Deno.test("takeover discovery refuses candidate, repository, branch, source and custody mismatches", async (t) => {
  const cases: [
    string,
    (r: ReturnType<typeof discoveryRig>) => void,
    string,
  ][] = [
    ["candidate diverged", (r) => {
      r.record.target.head = SHA3;
    }, "candidate_divergent"],
    ["bound branch changed", (r) => {
      r.record.target.pr = 7;
      r.record.target.head = SHA2;
      r.record.target.branch = "other";
    }, "candidate_divergent"],
    ["explicit foreign PR", (r) => {
      r.source.issue.body = "https://github.com/other/repo/pull/7";
    }, "foreign_repository"],
    ["native foreign PR", (r) => {
      r.source.pulls[0].repository.name = "other";
      r.source.pulls[0].baseRepository.name = "other";
    }, "foreign_repository"],
    ["fork", (r) => {
      for (const p of [r.pull, r.source.pulls[0], r.reciprocal.pull]) {
        p.headRepository = {
          nodeId: "R_fork",
          owner: "contributor",
          name: "fork",
        };
      }
    }, "fork_head"],
    ["deleted fork", (r) => {
      for (const p of [r.pull, r.source.pulls[0], r.reciprocal.pull]) {
        p.headRepository = null;
      }
    }, "fork_head"],
    ["wrong base", (r) => {
      for (const p of [r.pull, r.source.pulls[0], r.reciprocal.pull]) {
        p.baseRef = "other";
      }
    }, "custody_unproven"],
    ["Contents unavailable", (r) => {
      r.control.contents = false;
    }, "unwritable_branch"],
    ["classic protection", (r) => {
      r.control.protected = true;
    }, "unwritable_branch"],
    ["active rule", (r) => {
      r.control.rules = true;
    }, "unwritable_branch"],
    ["protected path", (r) => {
      r.control.paths = false;
    }, "protected_path"],
    ["moved branch", (r) => {
      r.control.branchHead = SHA3;
    }, "head_moved"],
    ["missing branch", (r) => {
      r.control.branchHead = null;
    }, "head_moved"],
    ["moved base", (r) => {
      r.control.baseHead = SHA3;
    }, "head_moved"],
    ["missing base", (r) => {
      r.control.baseHead = null;
    }, "head_moved"],
    ["REST head moved", (r) => {
      r.pull.head = SHA3;
    }, "head_moved"],
    ["reciprocal head moved", (r) => {
      r.reciprocal.pull.head = SHA3;
    }, "head_moved"],
    ["native node replaced", (r) => {
      r.pull.nodeId = "PR_replaced";
    }, "head_moved"],
    ["missing reciprocal link", (r) => {
      r.reciprocal.issues = [];
    }, "association_unproven"],
    ["wrong reciprocal node", (r) => {
      r.reciprocal.issues[0].nodeId = "I_other";
    }, "association_unproven"],
    ["queue custody", (r) => {
      r.control.queue = { status: "hold", reason: "custody", pull: null };
    }, "queue_custody"],
    ["missing queue capability", (r) => {
      r.deps.port = { readRef: r.deps.port.readRef };
    }, "queue_custody"],
    ["source changed", (r) => {
      r.control.beforeRead = (kind, count) => {
        if (kind === "source" && count === 2) r.source.issue.body = "changed";
      };
    }, "source_changed"],
    ["PR moved before final read", (r) => {
      r.control.beforeRead = (kind, count) => {
        if (kind === "rest" && count === 2) r.pull.head = SHA3;
      };
    }, "head_moved"],
    ["source changed during Git", (r) => {
      r.control.beforeGit = () => {
        r.source.issue.body = "changed after source observation";
      };
    }, "source_changed"],
  ];
  for (const [name, change, reason] of cases) {
    await t.step(name, async () => {
      const r = discoveryRig();
      change(r);
      const result = await r.discover();
      assert.equal(result.status, "owner_park");
      if (result.status === "owner_park") assert.equal(result.reason, reason);
    });
  }
});

Deno.test("takeover discovery unreadable and partial evidence is never successful absence", async (t) => {
  const changes: [string, (r: ReturnType<typeof discoveryRig>) => void][] = [
    ["closed issue", (r) => {
      r.source.issue.state = "closed";
    }],
    ["wrong record repository", (r) => {
      r.record.repository.name = "other";
    }],
    ["wrong source id", (r) => {
      r.record.source.id = "2";
    }],
    ["invalid branch", (r) => {
      for (const p of [r.pull, r.source.pulls[0], r.reciprocal.pull]) {
        p.headRef = "bad..branch";
      }
    }],
    ["protection error", (r) => {
      r.control.failProtections = true;
    }],
    ["rules error", (r) => {
      r.control.failRules = true;
    }],
    ["ref error", (r) => {
      r.control.failRef = true;
    }],
    ["Git error", (r) => {
      r.control.failGit = true;
    }],
    ["deadline", (r) => {
      r.clock.advance(10_000);
    }],
    ["deadline during Git", (r) => {
      r.control.beforeGit = () => r.clock.advance(10_000);
    }],
  ];
  for (const kind of ["source", "rest", "reciprocal"] as const) {
    for (const fault of ["http", "missing", "throw"] as const) {
      changes.push([`${kind}/${fault}`, (r) => {
        r.control.faults[kind] = fault;
      }]);
    }
    if (kind !== "rest") {
      changes.push([`${kind}/partial`, (r) => {
        r.control.faults[kind] = "partial";
      }]);
    }
  }
  for (const [name, change] of changes) {
    await t.step(name, async () => {
      const r = discoveryRig();
      change(r);
      const result = await r.discover();
      assert.equal(result.status, "unavailable");
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
});

Deno.test("takeover discovery native-open and REST-closed contradiction cannot permit duplicate work", async () => {
  const r = discoveryRig();
  r.pull.state = "closed";
  assert.notEqual((await r.discover()).status, "none");
});

Deno.test("takeover explicit references accept only explicit PR forms with bounded repository identities", () => {
  assert.deepEqual(explicitPullReferences("#7 and /issues/7", REPO), {
    numbers: [],
    foreign: false,
    invalid: false,
  });
  assert.deepEqual(
    explicitPullReferences("PR #7, pull request #8, PR #7", REPO),
    { numbers: [7, 8], foreign: false, invalid: false },
  );
  assert.equal(
    explicitPullReferences("PR #9007199254740992", REPO).invalid,
    true,
  );
  assert.equal(
    explicitPullReferences("https://github.com/other/repo/pull/7", REPO)
      .foreign,
    true,
  );
});
