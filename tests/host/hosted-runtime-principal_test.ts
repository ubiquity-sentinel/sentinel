import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portError } from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  principalGrant,
  selfInstallPrincipalFixture,
} from "./hosted-app-principal-fixtures.ts";
import { principalLauncherFixture } from "./hosted-runtime-principal-fixtures.ts";
import { OBSERVED } from "../github/hosted-execution-helpers.ts";

Deno.test("hosted principal launcher: installed successor grant reaches actual child without a profile", async () => {
  const rig = await principalLauncherFixture(true);
  try {
    await selfInstallPrincipalFixture(rig);
    rig.input.env = {
      ...rig.input.env,
      GITHUB_SHA: rig.identity.launcherSha,
      GITHUB_WORKFLOW_SHA: rig.identity.launcherSha,
    };
    // Keep synthetic native HTTP while exercising the production source default.
    Reflect.deleteProperty(
      rig.input.principalHandoffFixture!,
      "sourceProfiles",
    );
    const result = await rig.launch();
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(rig.childCalls().length, 1);
    assert(rig.model.calls.length > 0);
    assert.equal(rig.state.repairWrites, 0);
  } finally {
    await rig.close();
  }
});

Deno.test("hosted principal launcher: verified repair/planner grants reach actual owned children, while cells get none", async (t) => {
  for (const job of ["repair", "matrix_plan", "matrix_cell"] as const) {
    await t.step(job, async () => {
      const rig = await principalLauncherFixture(job !== "matrix_cell", job);
      try {
        const before = canonicalStringify(rig.state.release);
        const result = await rig.launch();
        assert.equal(result.status, "healthy");
        assert.equal(rig.childCalls().length, 1);
        assert.equal(rig.state.repairWrites, 0);
        assert.equal(canonicalStringify(rig.state.release), before);
        assert.equal(rig.model.calls.length > 0, job !== "matrix_cell");
        assert(
          rig.model.calls.every((call) => call.path.includes("/actions/")),
        );
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("hosted principal launcher: dormant, forged, native, source and state refusal removes only the grant", async (t) => {
  for (
    const scenario of [
      "dormant",
      "forged grant",
      "expired grant",
      "native fallback",
      "missing App",
      "native job completed",
      "native source drift",
      "hidden source drift",
      "source drift during native GET",
      "health lost during native GET",
      "deadline elapsed during native GET",
      "saved health lost",
      "saved execution drift",
      "repair state unavailable",
      "release hold",
      "repair hold",
      "native rate limited",
    ]
  ) {
    await t.step(scenario, async () => {
      const tokenKind = scenario === "native fallback"
        ? "native"
        : scenario === "missing App"
        ? "absent"
        : "app";
      const rig = await principalLauncherFixture(false, "repair", tokenKind);
      const originalFetch = globalThis.fetch;
      let nativeFetches = 0;
      try {
        if (scenario === "dormant") {
          delete rig.input.principalHandoffFixture;
          globalThis.fetch = () => {
            nativeFetches++;
            return Promise.reject(new Error("unexpected native fixture fetch"));
          };
        } else if (scenario === "forged grant") {
          rig.input.env = {
            ...rig.input.env,
            SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: principalGrant({ appId: 1 }),
          };
        } else if (scenario === "expired grant") {
          rig.input.env = {
            ...rig.input.env,
            SENTINEL_SUPERVISOR_TOKEN_MINT_GRANT: principalGrant({
              expiresAt: new Date(OBSERVED).toISOString(),
            }),
          };
        } else if (scenario === "native job completed") {
          rig.model.jobs[0].status = "completed";
        } else if (scenario === "native source drift") {
          rig.model.attempt.head_sha = "f".repeat(40);
        } else if (scenario === "hidden source drift") {
          const path = "src/host/hosted-runtime-child.ts";
          await rig.git(rig.launcher, [
            "update-index",
            "--assume-unchanged",
            path,
          ]);
          await rig.write(rig.launcher, path, "unreviewed fixture bytes\n");
        } else if (scenario === "source drift during native GET") {
          const path = "src/host/hosted-runtime-child.ts";
          await rig.git(rig.launcher, [
            "update-index",
            "--assume-unchanged",
            path,
          ]);
          rig.model.mutateBeforeReply = (_request, count) => {
            if (count === 1) {
              Deno.writeTextFileSync(
                rig.launcher + "/" + path,
                "source moved during native verification\n",
              );
            }
          };
        } else if (scenario === "health lost during native GET") {
          rig.model.mutateBeforeReply = (_request, count) => {
            if (count !== 1) return;
            const release = parseReleaseStateSnapshotV1(
              rig.state.release!.snapshot,
            );
            release.hostedRuntimes[0].lastHealthyProof = null;
            rig.state.setRelease(release);
          };
        } else if (scenario === "deadline elapsed during native GET") {
          rig.model.mutateBeforeReply = (_request, count) => {
            if (count === 1) rig.setNow(OBSERVED + 31_000);
          };
        } else if (scenario === "saved health lost") {
          const release = parseReleaseStateSnapshotV1(
            rig.state.release!.snapshot,
          );
          release.hostedRuntimes[0].lastHealthyProof = null;
          rig.state.setRelease(release);
        } else if (scenario === "saved execution drift") {
          let reads = 0;
          const read = rig.input.state.readRelease;
          rig.input.state.readRelease = () => {
            if (++reads === 2) {
              const release = parseReleaseStateSnapshotV1(
                rig.state.release!.snapshot,
              );
              release.hostedRuntimes[0].execution!.createdAt++;
              rig.state.setRelease(release);
            }
            return read();
          };
        } else if (scenario === "repair state unavailable") {
          rig.input.state.readRepair = () =>
            Promise.resolve(portError("unavailable", "fixture read refusal"));
        } else if (scenario.endsWith(" hold")) {
          const hold = {
            installationId: 0,
            observedAt: OBSERVED,
            retryNotBefore: scenario === "release hold"
              ? null
              : OBSERVED + 60_000,
            observationId: "a".repeat(64),
            secondaryBackoff: 0,
          };
          if (scenario === "release hold") {
            const release = parseReleaseStateSnapshotV1(
              rig.state.release!.snapshot,
            );
            release.githubCooldowns = [hold];
            rig.state.setRelease(release);
          } else rig.state.repair!.githubCooldowns = [hold];
          rig.input.env = { ...rig.input.env, SENTINEL_COOLDOWN_MODE: "off" };
        } else if (scenario === "native rate limited") {
          rig.model.rejectPath = "/actions/";
          rig.model.rejectStatus = 429;
        }
        const before = canonicalStringify(rig.state.repair);
        const result = await rig.launch();
        assert.equal(result.status, "healthy", scenario);
        assert.equal(rig.childCalls().length, 1);
        assert.equal(rig.state.repairWrites, 0);
        assert.equal(canonicalStringify(rig.state.repair), before);
        assert.equal(nativeFetches, 0, "dormant production does not fetch");
        if (
          [
            "dormant",
            "forged grant",
            "expired grant",
            "native fallback",
            "missing App",
            "hidden source drift",
            "saved health lost",
            "saved execution drift",
            "repair state unavailable",
            "release hold",
            "repair hold",
          ].includes(scenario)
        ) {
          assert.equal(rig.model.calls.length, 0, scenario);
        }
        if (scenario === "native rate limited") {
          assert.equal(rig.model.calls.length, 1);
        }
      } finally {
        globalThis.fetch = originalFetch;
        await rig.close();
      }
    });
  }
});

Deno.test("hosted principal launcher: the grant binds to the live target installation the child reads", async (t) => {
  const live = 173913802;
  for (
    const scenario of [
      {
        name: "live grant and live id reach the child",
        expected: true,
        grant: principalGrant({ installationId: live }),
        id: String(live),
        handoff: { outcome: "retained", refusal: null },
      },
      {
        name: "durable grant under the live id is stripped",
        expected: false,
        grant: principalGrant(),
        id: String(live),
        handoff: { outcome: "refused", refusal: "grant_installation" },
      },
      {
        name: "live grant under the durable default is stripped",
        expected: false,
        grant: principalGrant({ installationId: live }),
        id: undefined,
        handoff: { outcome: "refused", refusal: "grant_installation" },
      },
      {
        name: "malformed live id strips the grant and the child refuses it",
        expected: false,
        grant: principalGrant(),
        id: "17391380x",
        status: "failed",
        handoff: { outcome: "installation_invalid", refusal: null },
      },
    ]
  ) {
    await t.step(scenario.name, async () => {
      const rig = await principalLauncherFixture(
        scenario.expected,
        "repair",
        "app",
        {
          mintGrant: scenario.grant,
          targetInstallationId: scenario.id,
        },
      );
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        let result;
        try {
          result = await rig.launch();
        } finally {
          console.log = log;
        }
        assert.equal(
          result.status,
          scenario.status ?? "healthy",
          JSON.stringify(result),
        );
        assert.equal(rig.childCalls().length, 1);
        assert.equal(rig.state.repairWrites, 0);
        // A grant refused before verification never issues a native read.
        if (!scenario.expected) assert.equal(rig.model.calls.length, 0);
        // #193: every withheld grant names its refusal class in one line.
        const handoff = lines.flatMap((line) => {
          try {
            const value = JSON.parse(line);
            return value?.kind === "sentinel_app_grant_handoff" ? [value] : [];
          } catch {
            return [];
          }
        });
        assert.deepEqual(handoff, [{
          version: "v1",
          kind: "sentinel_app_grant_handoff",
          job: "repair",
          ...scenario.handoff,
        }]);
        assert.doesNotMatch(lines.join("\n"), /appId|expiresAt/);
      } finally {
        await rig.close();
      }
    });
  }
});
