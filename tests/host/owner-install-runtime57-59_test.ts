import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { parseHostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import {
  CONCURRENCY_PLANNER_REVISION,
  CONCURRENCY_PRIOR_REVISION,
  CONCURRENCY_RETRY_REVISION,
  CONCURRENCY_REVISION,
  NOW,
  T0,
  UNRELATED,
} from "./owner-install-fixture-constants.ts";
import {
  acceptedRelease,
  cooldown,
  executionIntent,
  failedProof,
  healthyProof,
  hostedProof,
  notStartedProof,
  releaseSnapshot,
  requestedRelease,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";

Deno.test(
  "owner install runtime57: real installer saves healthy56, installs the exact pin once and leaves accepted57 terminal",
  async () => {
    const prior = healthyProof(CONCURRENCY_PRIOR_REVISION, 56, 37106475267);
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: CONCURRENCY_PRIOR_REVISION,
        generation: 56,
        healthyProof: prior,
        executionProof: prior,
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const fixture = await concurrencyInstallerFixture(state);
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.patches(), 1);
      assert.equal(fixture.reports.at(-1)?.status, "installed");
      assert.equal(
        fixture.reports.at(-1)?.candidateRevision,
        CONCURRENCY_REVISION,
      );
      assert.equal(fixture.reports.at(-1)?.candidateGeneration, 57);
      const read = await fixture.read();
      assert.equal(read.ok, true);
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing installed state");
      }
      const installed = read.value.snapshot;
      const runtime = installed.hostedRuntimes[0];
      assert.equal(runtime.activeRevision, CONCURRENCY_REVISION);
      assert.equal(runtime.generation, 57);
      assert.deepEqual(runtime.lastHealthyProof, prior);
      assert.deepEqual(installed.hostedReleases, state.hostedReleases);
      assert.deepEqual(installed.releases, state.releases);
      assert.deepEqual(installed.githubCooldowns, state.githubCooldowns);
      const message = await fixture.message();
      const recorded = JSON.parse(message.trim().split("\n").at(-1)!);
      assert.equal(recorded.stateHead, fixture.beforeHead);
      assert.equal(recorded.priorRevision, CONCURRENCY_PRIOR_REVISION);
      assert.equal(recorded.priorGeneration, 56);
      assert.equal(recorded.nextRevision, CONCURRENCY_REVISION);
      assert.equal(recorded.nextGeneration, 57);
      assert.deepEqual(recorded.priorHealthyProof, prior);
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "waiting");
      assert.equal(fixture.patches(), 1);
      const accepted = healthyProof(CONCURRENCY_REVISION, 57, 901);
      assert.equal(
        planOwnerDevelopmentInstall({
          ...installed,
          hostedRuntimes: [{
            ...runtime,
            lastHealthyProof: accepted,
            lastExecutionProof: accepted,
          }],
        }, NOW).status,
        "no_change",
      );
    } finally {
      await fixture.close();
    }
  },
);

Deno.test(
  "owner install runtime57: real installer restores saved0fc at58 once before its own health",
  async () => {
    const prior = healthyProof(CONCURRENCY_PRIOR_REVISION, 56, 37106475267);
    const runtime = runtimeRecord({
      revision: CONCURRENCY_REVISION,
      generation: 57,
      healthyProof: prior,
      executionProof: failedProof(CONCURRENCY_REVISION, 57, 902),
    });
    const state = releaseSnapshot({
      runtime,
      hostedReleases: [acceptedRelease()],
    });
    const fixture = await concurrencyInstallerFixture(state);
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
      assert.equal(
        fixture.reports.at(-1)?.candidateRevision,
        CONCURRENCY_PRIOR_REVISION,
      );
      assert.equal(fixture.reports.at(-1)?.candidateGeneration, 58);
      assert.equal(fixture.patches(), 1);
      assert.ok(
        !fixture.requests.some((request) =>
          request.path.includes("/compare/") ||
          request.path.includes("/check-runs")
        ),
      );
      const read = await fixture.read();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing rollback state");
      }
      const restored = read.value.snapshot;
      assert.deepEqual(restored.hostedReleases, state.hostedReleases);
      assert.deepEqual(restored.hostedRuntimes[0].lastHealthyProof, prior);
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "waiting");
      assert.equal(fixture.patches(), 1);
      const proven58 = healthyProof(CONCURRENCY_PRIOR_REVISION, 58, 903);
      assert.equal(
        planOwnerDevelopmentInstall(
          {
            ...restored,
            hostedRuntimes: [{
              ...restored.hostedRuntimes[0],
              lastHealthyProof: proven58,
              lastExecutionProof: proven58,
            }],
          },
          NOW,
          undefined,
          undefined,
          DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
          DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
          DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
        ).status,
        "install",
      );
    } finally {
      await fixture.close();
    }
    for (
      const proof of [
        null,
        healthyProof(UNRELATED, 56),
        healthyProof(CONCURRENCY_PRIOR_REVISION, 55),
        healthyProof(CONCURRENCY_REVISION, 57),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({ runtime: { ...runtime, lastHealthyProof: proof } }),
          NOW,
        ).status,
        "waiting",
      );
    }
    for (
      const proof of [
        null,
        notStartedProof(CONCURRENCY_REVISION, 57),
        failedProof(UNRELATED, 57),
        failedProof(CONCURRENCY_REVISION, 56),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: { ...runtime, lastExecutionProof: proof },
          }),
          NOW,
        ).status,
        "waiting",
      );
    }
  },
);

Deno.test(
  "owner install runtime57: real consumer refuses bad proof, active owner, release, source, CI, artifacts, changed parent and mismatched readback",
  async () => {
    const prior = healthyProof(CONCURRENCY_PRIOR_REVISION, 56, 37106475267);
    const runtime = runtimeRecord({
      revision: CONCURRENCY_PRIOR_REVISION,
      generation: 56,
      healthyProof: prior,
      executionProof: prior,
    });
    const healthy = releaseSnapshot({ runtime });
    const accepted57 = healthyProof(CONCURRENCY_REVISION, 57, 904);
    const cases: {
      state: ReleaseStateSnapshotV1;
      refusal?: Parameters<typeof concurrencyInstallerFixture>[1];
      status: string;
      patches?: number;
    }[] = [
      {
        state: releaseSnapshot({
          runtime: { ...runtime, lastHealthyProof: null },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            lastHealthyProof: healthyProof(CONCURRENCY_PRIOR_REVISION, 55),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            lastExecutionProof: failedProof(CONCURRENCY_PRIOR_REVISION, 56),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            lastExecutionProof: failedProof(UNRELATED, 57),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            execution: executionIntent(CONCURRENCY_PRIOR_REVISION, 56),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime,
          hostedReleases: [requestedRelease()],
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({ runtime, cooldowns: [cooldown(null)] }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: runtimeRecord({
            revision: UNRELATED,
            generation: 59,
            healthyProof: healthyProof(UNRELATED, 59),
          }),
        }),
        status: "no_change",
      },
      {
        state: releaseSnapshot({
          runtime: runtimeRecord({
            revision: CONCURRENCY_REVISION,
            generation: 57,
            healthyProof: accepted57,
            executionProof: accepted57,
          }),
        }),
        status: "no_change",
      },
      { state: healthy, refusal: "ancestry", status: "waiting" },
      { state: healthy, refusal: "ci", status: "waiting" },
      { state: healthy, refusal: "artifact", status: "waiting" },
      { state: healthy, refusal: "parent", status: "failed" },
      { state: healthy, refusal: "readback", status: "failed", patches: 1 },
    ];
    for (const entry of cases) {
      const fixture = await concurrencyInstallerFixture(
        entry.state,
        entry.refusal,
      );
      try {
        assert.equal(await fixture.run(), 0);
        assert.equal(
          fixture.reports.at(-1)?.status,
          entry.status,
          entry.refusal,
        );
        assert.equal(fixture.patches(), entry.patches ?? 0, entry.refusal);
        if (entry.refusal !== "parent" && entry.refusal !== "readback") {
          assert.equal(await fixture.head(), fixture.beforeHead);
        }
        if (entry.refusal === undefined || entry.refusal === "artifact") {
          assert.equal(fixture.requests.length, 0);
        }
        if (entry.refusal === "ancestry" || entry.refusal === "ci") {
          assert.ok(
            fixture.requests.every((request) => request.method === "GET"),
          );
        }
      } finally {
        await fixture.close();
      }
    }
  },
);

Deno.test(
  "owner install runtime59: own healthy58 installs the fixed successor once with saved bootstrap proof",
  async () => {
    const prior = hostedProof({
      runId: 37126530084,
      purpose: "bootstrap",
      releaseId: null,
      revision: CONCURRENCY_PRIOR_REVISION,
      generation: 58,
      outcome: "healthy",
    });
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: CONCURRENCY_PRIOR_REVISION,
        generation: 58,
        healthyProof: prior,
        executionProof: prior,
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const fixture = await concurrencyInstallerFixture(
      state,
      undefined,
      CONCURRENCY_RETRY_REVISION,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "installed");
      assert.equal(
        fixture.reports.at(-1)?.candidateRevision,
        CONCURRENCY_RETRY_REVISION,
      );
      assert.equal(fixture.reports.at(-1)?.candidateGeneration, 59);
      assert.equal(fixture.patches(), 1);
      const read = await fixture.read();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing installed successor");
      }
      const installed = read.value.snapshot;
      assert.equal(
        installed.hostedRuntimes[0].activeRevision,
        CONCURRENCY_RETRY_REVISION,
      );
      assert.equal(installed.hostedRuntimes[0].generation, 59);
      assert.deepEqual(installed.hostedRuntimes[0].lastHealthyProof, prior);
      assert.deepEqual(installed.hostedReleases, state.hostedReleases);
      assert.deepEqual(installed.githubCooldowns, state.githubCooldowns);
      const recorded = JSON.parse(
        (await fixture.message()).trim().split("\n").at(-1)!,
      );
      assert.equal(recorded.stateHead, fixture.beforeHead);
      assert.equal(recorded.priorRevision, CONCURRENCY_PRIOR_REVISION);
      assert.equal(recorded.priorGeneration, 58);
      assert.equal(recorded.nextRevision, CONCURRENCY_RETRY_REVISION);
      assert.equal(recorded.nextGeneration, 59);
      assert.deepEqual(recorded.priorHealthyProof, prior);
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "waiting");
      assert.equal(fixture.patches(), 1);
    } finally {
      await fixture.close();
    }
  },
);

Deno.test(
  "owner install runtime59: exact failed59 restores only saved healthy0fc58 once at terminal60",
  async () => {
    const prior = healthyProof(CONCURRENCY_PRIOR_REVISION, 58, 37126530084);
    const runtime = runtimeRecord({
      revision: CONCURRENCY_RETRY_REVISION,
      generation: 59,
      healthyProof: prior,
      executionProof: failedProof(CONCURRENCY_RETRY_REVISION, 59, 1002),
    });
    const state = releaseSnapshot({
      runtime,
      hostedReleases: [acceptedRelease()],
    });
    const fixture = await concurrencyInstallerFixture(
      state,
      undefined,
      CONCURRENCY_RETRY_REVISION,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
      assert.equal(
        fixture.reports.at(-1)?.candidateRevision,
        CONCURRENCY_PRIOR_REVISION,
      );
      assert.equal(fixture.reports.at(-1)?.candidateGeneration, 60);
      assert.equal(fixture.patches(), 1);
      assert.ok(
        !fixture.requests.some((request) =>
          request.path.includes("/compare/") ||
          request.path.includes("/check-runs")
        ),
      );
      const read = await fixture.read();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing successor rollback");
      }
      assert.deepEqual(
        read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        prior,
      );
      assert.deepEqual(
        read.value.snapshot.hostedReleases,
        state.hostedReleases,
      );
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "no_change");
      assert.equal(fixture.patches(), 1);
    } finally {
      await fixture.close();
    }
    for (
      const proof of [
        null,
        healthyProof(CONCURRENCY_PRIOR_REVISION, 56),
        healthyProof(UNRELATED, 58),
        healthyProof(CONCURRENCY_RETRY_REVISION, 59),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({ runtime: { ...runtime, lastHealthyProof: proof } }),
          NOW,
        ).status,
        "waiting",
      );
    }
    for (
      const proof of [
        null,
        notStartedProof(CONCURRENCY_RETRY_REVISION, 59),
        failedProof(CONCURRENCY_RETRY_REVISION, 58),
        failedProof(UNRELATED, 59),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: { ...runtime, lastExecutionProof: proof },
          }),
          NOW,
        ).status,
        "waiting",
      );
    }
  },
);

Deno.test(
  "owner install runtime59: real consumer preserves proof owner CI CAS and terminal guards",
  async () => {
    const prior = healthyProof(CONCURRENCY_PRIOR_REVISION, 58, 37126530084);
    const runtime = runtimeRecord({
      revision: CONCURRENCY_PRIOR_REVISION,
      generation: 58,
      healthyProof: prior,
      executionProof: prior,
    });
    const healthy = releaseSnapshot({ runtime });
    const accepted59 = healthyProof(CONCURRENCY_RETRY_REVISION, 59, 1003);
    const restored60 = healthyProof(CONCURRENCY_PRIOR_REVISION, 60, 1004);
    const cases: {
      state: ReleaseStateSnapshotV1;
      refusal?: Parameters<typeof concurrencyInstallerFixture>[1];
      status: string;
      patches?: number;
    }[] = [
      {
        state: releaseSnapshot({
          runtime: { ...runtime, lastHealthyProof: null },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            lastHealthyProof: healthyProof(CONCURRENCY_PRIOR_REVISION, 56),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: { ...runtime, lastExecutionProof: null },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            lastExecutionProof: failedProof(CONCURRENCY_PRIOR_REVISION, 58),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            lastExecutionProof: parseHostedRunProofV1({
              ...prior,
              observedAt: T0 + 2500,
            }),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            execution: executionIntent(CONCURRENCY_PRIOR_REVISION, 58),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime,
          hostedReleases: [requestedRelease()],
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({ runtime, cooldowns: [cooldown(null)] }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({ runtime, cooldowns: [cooldown(NOW + 1)] }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: runtimeRecord({
            revision: CONCURRENCY_RETRY_REVISION,
            generation: 59,
            healthyProof: accepted59,
            executionProof: accepted59,
          }),
        }),
        status: "installed",
        patches: 1,
      },
      {
        state: releaseSnapshot({
          runtime: runtimeRecord({
            revision: CONCURRENCY_PRIOR_REVISION,
            generation: 60,
            healthyProof: restored60,
            executionProof: restored60,
          }),
        }),
        status: "no_change",
      },
      { state: healthy, refusal: "ancestry", status: "waiting" },
      { state: healthy, refusal: "ci", status: "waiting" },
      { state: healthy, refusal: "artifact", status: "waiting" },
      { state: healthy, refusal: "parent", status: "failed" },
      { state: healthy, refusal: "readback", status: "failed", patches: 1 },
    ];
    for (const entry of cases) {
      const fixture = await concurrencyInstallerFixture(
        entry.state,
        entry.refusal,
        entry.status === "installed"
          ? CONCURRENCY_PLANNER_REVISION
          : CONCURRENCY_RETRY_REVISION,
      );
      try {
        assert.equal(await fixture.run(), 0);
        assert.equal(
          fixture.reports.at(-1)?.status,
          entry.status,
          entry.refusal,
        );
        assert.equal(fixture.patches(), entry.patches ?? 0, entry.refusal);
        if (entry.status === "installed") {
          assert.equal(
            fixture.reports.at(-1)?.candidateRevision,
            CONCURRENCY_PLANNER_REVISION,
          );
          assert.equal(fixture.reports.at(-1)?.candidateGeneration, 60);
        } else if (entry.refusal !== "parent" && entry.refusal !== "readback") {
          assert.equal(await fixture.head(), fixture.beforeHead);
        }
        if (
          entry.status !== "installed" &&
          (entry.refusal === undefined || entry.refusal === "artifact")
        ) {
          assert.equal(fixture.requests.length, 0);
        }
      } finally {
        await fixture.close();
      }
    }
  },
);
