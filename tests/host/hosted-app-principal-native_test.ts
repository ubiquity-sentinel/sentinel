import assert from "node:assert/strict";
import {
  hostedAppPrincipalNotAfter,
  parseHostedAppMintGrant,
} from "../../src/host/hosted-app-grant.ts";
import {
  readHostedAppNativeJob,
  readHostedAppRepositoryScope,
} from "../../src/host/hosted-app-principal-native.ts";
import { OBSERVED } from "../github/hosted-execution-helpers.ts";
import { runMintFixture } from "./hosted-app-mint-fixtures.ts";
import {
  principalGrant,
  principalNativeFixture,
} from "./hosted-app-principal-fixtures.ts";

Deno.test("hosted principal: actual mint output parses as inert metadata and can only lower the conservative window", async () => {
  const native = await runMintFixture();
  const now = Date.now();
  const grant = parseHostedAppMintGrant(native.output["mint-grant"], now);
  assert(grant !== null);
  assert.equal(
    hostedAppPrincipalNotAfter(grant, String(now), now),
    now + 58 * 60 * 1000,
  );
  assert.equal(
    hostedAppPrincipalNotAfter(
      { ...grant, expiresAt: now + 15_000 },
      String(now),
      now,
    ),
    now + 15_000,
  );
  assert.equal(hostedAppPrincipalNotAfter(grant, undefined, now), null);
  assert.equal(
    hostedAppPrincipalNotAfter(grant, String(now + 120_000), now),
    null,
  );
  assert.equal(
    parseHostedAppMintGrant(native.output["mint-grant"], grant.expiresAt),
    null,
  );
});

Deno.test("hosted principal: actual wrong-App/read-only mint output is refused by the consumer", async () => {
  const native = await runMintFixture({
    installation: { app_id: 42, app_slug: "other-app" },
    response: { permissions: { contents: "read" } },
  });
  assert.equal(native.main.code, 0);
  assert.equal(
    parseHostedAppMintGrant(native.output["mint-grant"], Date.now()),
    null,
  );
});

Deno.test("hosted principal: current credential installations parse while the durable foreign scope stays legacy", () => {
  const self = parseHostedAppMintGrant(
    principalGrant({
      installationId: 173834540,
      repositoryIds: [101],
      repositoryNames: ["sentinel"],
    }),
    OBSERVED,
    173834540,
  );
  assert.equal(self?.installationId, 173834540);

  const foreign = parseHostedAppMintGrant(
    principalGrant({
      installationId: 173913802,
      repositoryIds: [102],
      repositoryNames: ["ai.ubq.fi"],
    }),
    OBSERVED,
    173913802,
  );
  assert.equal(foreign?.installationId, 173913802);
  assert.equal(
    parseHostedAppMintGrant(
      principalGrant({ installationId: 173913802 }),
      OBSERVED,
      155687488,
    ),
    null,
  );
});

Deno.test("hosted principal: live foreign and self credential installations preserve logical scopes", async () => {
  const foreignRig = principalNativeFixture();
  foreignRig.scopeInput.grant = {
    ...foreignRig.grant,
    installationId: 173913802,
  };
  const foreign = await readHostedAppRepositoryScope(foreignRig.scopeInput);
  assert(foreign.ok);
  assert.equal(foreign.value.owner, "ubiquity");
  assert.equal(foreign.value.name, "ai.ubq.fi");

  const selfRig = principalNativeFixture();
  selfRig.scopeInput.repository = {
    owner: "ubiquity-sentinel",
    name: "sentinel",
    installationId: 0,
  };
  selfRig.scopeInput.grant = {
    ...selfRig.grant,
    installationId: 173834540,
    repositoryIds: [101],
    repositoryNames: ["sentinel"],
  };
  const self = await readHostedAppRepositoryScope(selfRig.scopeInput);
  assert(self.ok);
  assert.equal(self.value.owner, "ubiquity-sentinel");
  assert.equal(self.value.name, "sentinel");
});

Deno.test("hosted principal: forged, malformed, overbroad and expired metadata is not accepted", () => {
  for (
    const patch of [
      { version: 2 },
      { appId: 42 },
      { installationId: 0 },
      { appSlug: "github-actions" },
      { permissions: { contents: "read" } },
      { permissions: { contents: "write", arbitrary: "write" } },
      { token: "forged" },
      { repositoryIds: [101, 101] },
      { repositoryNames: ["sentinel", "Sentinel"] },
      { expiresAt: "invalid" },
      { expiresAt: new Date(OBSERVED).toISOString() },
    ]
  ) {
    assert.equal(
      parseHostedAppMintGrant(principalGrant(patch), OBSERVED),
      null,
    );
  }
  assert.equal(parseHostedAppMintGrant(" ".repeat(16_385), OBSERVED), null);
  assert.equal(parseHostedAppMintGrant(undefined, OBSERVED), null);
});

Deno.test("hosted principal: invalid clock refuses before a native request", async () => {
  for (const now of [NaN, Infinity, -Infinity, OBSERVED + 0.5]) {
    const rig = principalNativeFixture();
    rig.setNow(now);
    assert.equal((await readHostedAppNativeJob(rig.jobInput)).ok, false);
    assert.equal(
      (await readHostedAppRepositoryScope(rig.scopeInput)).ok,
      false,
    );
    assert.deepEqual(rig.model.calls, []);
  }
});

for (const job of ["repair", "matrix_plan"] as const) {
  Deno.test(`hosted principal: exact live ${job} observes successful setup/mint and current runtime`, async () => {
    const rig = principalNativeFixture(job);
    const result = await readHostedAppNativeJob(rig.jobInput);
    assert(result.ok);
    assert.equal(result.value.jobId, 901);
    assert.equal(rig.model.calls.length, 3);
    assert(
      rig.model.calls.every((row) => row.token === "fixture-native-actions"),
    );
  });
}

Deno.test("hosted principal: wrong native attempt, source, mint or execution refuses", async (t) => {
  const cases: Array<
    [string, (rig: ReturnType<typeof principalNativeFixture>) => void]
  > = [
    ["attempt", (r) => {
      r.model.attempt.run_attempt = 3;
    }],
    ["workflow", (r) => {
      r.model.attempt.workflow_id = 1;
    }],
    ["source", (r) => {
      r.model.attempt.head_sha = "f".repeat(40);
    }],
    ["terminal", (r) => {
      r.model.attempt.status = "completed";
    }],
    ["cell", (r) => {
      r.jobInput.identity.job = "matrix_cell";
    }],
    ["verification", (r) => {
      r.jobInput.execution.purpose = "bootstrap";
    }],
    ["duplicate job", (r) => {
      r.model.jobs.push({ ...r.model.jobs[0], id: 902 });
    }],
    ["failed mint", (r) => {
      (r.model.jobs[0].steps as Array<Record<string, unknown>>)[1].conclusion =
        "failure";
    }],
    ["skipped setup", (r) => {
      (r.model.jobs[0].steps as Array<Record<string, unknown>>)[0].conclusion =
        "skipped";
    }],
    ["duplicate runtime", (r) => {
      const steps = r.model.jobs[0].steps as Array<Record<string, unknown>>;
      steps.push({ ...steps[2], number: 7 });
    }],
    ["late read", (r) => {
      r.model.mutateBeforeReply = () => r.setNow(OBSERVED + 31_000);
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.step(name, async () => {
      const rig = principalNativeFixture();
      mutate(rig);
      assert.equal((await readHostedAppNativeJob(rig.jobInput)).ok, false);
    });
  }
});

Deno.test("hosted principal: fresh attempt recheck rejects a completed run after its jobs read", async () => {
  const rig = principalNativeFixture();
  rig.model.mutateBeforeReply = (_request, count) => {
    if (count === 3) rig.model.attempt.status = "completed";
  };
  assert.equal((await readHostedAppNativeJob(rig.jobInput)).ok, false);
});

Deno.test("hosted principal: complete native pagination succeeds and truncated/foreign/duplicate evidence refuses", async (t) => {
  for (
    const defect of [
      "none",
      "truncated",
      "foreign next",
      "duplicate",
      "total drift",
    ] as const
  ) {
    await t.step(defect, async () => {
      const rig = principalNativeFixture();
      const active = rig.model.jobs[0];
      rig.model.jobs = Array.from(
        { length: 100 },
        (_, index) => ({
          ...active,
          id: index + 1000,
          name: `matrix_cell (${index})`,
        }),
      );
      rig.model.jobs.push(active);
      if (defect === "truncated") rig.model.omitNext = true;
      if (defect === "foreign next") {
        rig.model.nextLinkOverride =
          '<https://evil.example/jobs?per_page=100&page=2>; rel="next"';
      }
      if (defect === "duplicate") rig.model.jobs[10].id = rig.model.jobs[0].id;
      if (defect === "total drift") {
        rig.model.mutateBeforeReply = (request) => {
          if (request.url.endsWith("page=2")) rig.model.jobsTotalOverride = 102;
        };
      }
      assert.equal(
        (await readHostedAppNativeJob(rig.jobInput)).ok,
        defect === "none",
      );
    });
  }
});

Deno.test("hosted principal: actual App token scope binds native repository ID/node and explicit self scope0", async () => {
  const rig = principalNativeFixture();
  const foreign = await readHostedAppRepositoryScope(rig.scopeInput);
  assert(foreign.ok);
  assert.deepEqual(foreign.value, {
    id: 102,
    nodeId: "R_102",
    owner: "ubiquity",
    name: "ai.ubq.fi",
  });
  rig.scopeInput.repository = {
    owner: "ubiquity-sentinel",
    name: "sentinel",
    installationId: 0,
  };
  const self = await readHostedAppRepositoryScope(rig.scopeInput);
  assert(self.ok);
  assert.equal(self.value.id, 101);
  assert(
    rig.model.calls.every((row) => row.token === "fixture-App-installation"),
  );
});

Deno.test("hosted principal: revoked credential, missing scope, wrong installation and expiry fail closed", async (t) => {
  const cases: Array<
    [string, (rig: ReturnType<typeof principalNativeFixture>) => void]
  > = [
    ["revoked", (r) => {
      r.model.rejectPath = "/installation/repositories";
    }],
    ["forbidden", (r) => {
      r.model.rejectPath = "/installation/repositories";
      r.model.rejectStatus = 403;
    }],
    ["missing target", (r) => {
      r.model.repositories = r.model.repositories.slice(0, 1);
    }],
    ["foreign logical installation", (r) => {
      r.scopeInput.repository.installationId = 999;
    }],
    ["scope0 alias", (r) => {
      r.scopeInput.repository.installationId = 0;
    }],
    ["wrong mint membership", (r) => {
      r.scopeInput.grant = { ...r.grant, repositoryIds: [101] };
    }],
    ["expired after read", (r) => {
      r.model.mutateBeforeReply = () => r.setNow(r.grant.expiresAt);
    }],
    ["changed native identity", (r) => {
      r.model.mutateBeforeReply = (request) => {
        if (request.url.includes("/repos/ubiquity/ai.ubq.fi")) {
          r.model.repositories[1].node_id = "R_changed";
        }
      };
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.step(name, async () => {
      const rig = principalNativeFixture();
      mutate(rig);
      assert.equal(
        (await readHostedAppRepositoryScope(rig.scopeInput)).ok,
        false,
      );
    });
  }
});

Deno.test("hosted principal: installation scope pagination cannot turn incomplete or duplicated inventory into membership", async (t) => {
  for (
    const defect of ["none", "truncated", "duplicate", "total drift"] as const
  ) {
    await t.step(defect, async () => {
      const rig = principalNativeFixture();
      const target = rig.model.repositories[1];
      rig.model.repositories = Array.from(
        { length: 100 },
        (_, index) => ({
          id: index + 1000,
          node_id: `R_${index + 1000}`,
          name: `repo-${index}`,
          full_name: `ubiquity/repo-${index}`,
          owner: { login: "ubiquity" },
        }),
      );
      rig.model.repositories.push(target);
      if (defect === "truncated") rig.model.omitNext = true;
      if (defect === "duplicate") {
        rig.model.repositories[1].id = rig.model.repositories[0].id;
      }
      if (defect === "total drift") {
        rig.model.mutateBeforeReply = (request) => {
          if (request.url.endsWith("page=2")) {
            rig.model.repositoriesTotalOverride = 102;
          }
        };
      }
      assert.equal(
        (await readHostedAppRepositoryScope(rig.scopeInput)).ok,
        defect === "none",
      );
    });
  }
});
