import assert from "node:assert/strict";
import {
  parseHostedAppSourceProfiles,
  readHostedAppSourceEvidence,
} from "../../src/host/hosted-app-principal-source.ts";
import {
  principalHostFixture,
  principalSourceFixture,
} from "./hosted-app-principal-fixtures.ts";
import {
  composeHostedAppGitHub,
  createHostedAppPrincipalContext,
  type HostedAppPrincipalContext,
  verifyHostedAppPrincipalHandoff,
} from "../../src/host/hosted-app-principal.ts";
import { LocalSessionTracker } from "../../src/host/local-client.ts";
import { OBSERVED } from "../github/hosted-execution-helpers.ts";
import { makeCandidateCtx } from "./actions-candidates-fixture.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";

Deno.test("hosted principal source: installed successor authenticates without a fixed profile", async () => {
  const rig = await principalHostFixture(true);
  try {
    assert(await readHostedAppSourceEvidence(rig.source) !== null);
    assert(await verifyHostedAppPrincipalHandoff(rig.hostInput));
    assert(await createHostedAppPrincipalContext(rig.hostInput) !== null);
    assert(rig.model.calls.length > 0, "actual native job proof is required");
    assert.equal(rig.state.repairWrites, 0);
  } finally {
    await rig.close();
  }
});

Deno.test("hosted principal source: installed successor still needs native mint and exact saved clean custody", async (t) => {
  for (
    const fault of [
      "saved pointer",
      "native head",
      "native mint",
      "hidden runtime",
      "different launcher",
    ]
  ) {
    await t.step(fault, async () => {
      const rig = await principalHostFixture(true);
      try {
        if (fault === "saved pointer") {
          const release = parseReleaseStateSnapshotV1(
            rig.state.release!.snapshot,
          );
          release.hostedRuntimes[0].lastHealthyProof = null;
          rig.state.setRelease(release);
        } else if (fault === "native head") {
          rig.model.attempt.head_sha = "f".repeat(40);
        } else if (fault === "native mint") {
          const steps = rig.model.jobs[0].steps as Array<{ name: string }>;
          steps[1].name = "untrusted mint name";
        } else if (fault === "different launcher") {
          rig.source.identity.launcherSha = "f".repeat(
            40,
          ) as typeof rig.identity.launcherSha;
        } else {
          const path = "src/host/hosted-custody-capability.json";
          await rig.git(rig.runtime, [
            "update-index",
            "--assume-unchanged",
            path,
          ]);
          await rig.write(rig.runtime, path, "{}\n");
        }
        assert.equal(
          await verifyHostedAppPrincipalHandoff(rig.hostInput),
          false,
        );
        assert.equal(
          await createHostedAppPrincipalContext(rig.hostInput),
          null,
        );
        assert.equal(rig.state.repairWrites, 0);
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("hosted principal source: actual clean launcher/runtime and full reviewed code profile are required", async () => {
  const rig = await principalSourceFixture();
  try {
    assert.equal(
      await readHostedAppSourceEvidence(rig.source),
      null,
      "production source profiles remain dormant",
    );
    const result = await readHostedAppSourceEvidence(rig.source, rig.profiles);
    assert(result !== null);
    assert.equal(result.codeSha256, rig.profiles[0].codeSha256);
    assert.deepEqual(result.targets, [
      "Ubiquity-Sentinel/sentinel",
      "ubiquity/ai.ubq.fi",
    ]);
    assert.deepEqual(JSON.parse(result.capabilityText), rig.capability);
    assert.deepEqual(result.steps, rig.names);
  } finally {
    await rig.close();
  }
});

Deno.test("hosted principal source: code drift, hidden tracked mutation, wrong runtime and forged profile refuse", async (t) => {
  for (
    const change of [
      "code",
      "hidden code",
      "capability",
      "hidden capability",
      "runtime",
      "native launcher",
      "workflow profile",
      "target digest",
      "cell",
      "verification",
    ]
  ) {
    await t.step(change, async () => {
      const rig = await principalSourceFixture();
      try {
        if (change.includes("code")) {
          if (change === "hidden code") {
            await rig.git(rig.launcher, [
              "update-index",
              "--assume-unchanged",
              "src/host/hosted-runtime-child.ts",
            ]);
          }
          await rig.write(
            rig.launcher,
            "src/host/hosted-runtime-child.ts",
            "unreviewed handoff\n",
          );
        } else if (change.includes("capability")) {
          if (change === "hidden capability") {
            await rig.git(rig.launcher, [
              "update-index",
              "--assume-unchanged",
              "src/host/hosted-custody-capability.json",
            ]);
          }
          await rig.write(
            rig.launcher,
            "src/host/hosted-custody-capability.json",
            "{}\n",
          );
        } else if (change === "runtime") {
          rig.source.execution.revision = "f".repeat(
            40,
          ) as typeof rig.source.execution.revision;
        } else if (change === "native launcher") {
          rig.source.identity.launcherSha = "e".repeat(
            40,
          ) as typeof rig.source.identity.launcherSha;
        } else if (change === "workflow profile") {
          rig.profiles[0].codeSha256 = "0".repeat(64);
        } else if (change === "target digest") {
          rig.profiles[0].targetsSha256 = "0".repeat(64);
        } else if (change === "cell") rig.source.identity.job = "matrix_cell";
        else rig.source.execution.purpose = "bootstrap";
        assert.equal(
          await readHostedAppSourceEvidence(rig.source, rig.profiles),
          null,
        );
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("hosted principal source: malformed source-profile data cannot select a code graph", () => {
  for (
    const invalid of [null, {}, [{ version: 1 }], Array(33).fill({}), [{
      version: 1,
      codeSha256: "*",
      targetsSha256: "0".repeat(64),
      appClientId: "Iv23liHUJNXds9mU3j7Q",
      jobs: {},
    }]]
  ) {
    assert.throws(
      () => parseHostedAppSourceProfiles(invalid),
      /hosted App source evidence unavailable/,
    );
  }
});

Deno.test("hosted principal factory: actual source, live native job and healthy exact execution register an opaque context", async () => {
  const rig = await principalHostFixture();
  try {
    assert.equal(await createHostedAppPrincipalContext(rig.hostInput), null);
    const context = await createHostedAppPrincipalContext(
      rig.hostInput,
      rig.profiles,
    );
    assert(context !== null);
    assert.deepEqual(Object.keys(context), ["kind"]);
    assert.equal(
      JSON.stringify(context).includes(rig.hostInput.appToken!),
      false,
    );
    assert.equal(rig.state.repairWrites, 0);
  } finally {
    await rig.close();
  }
});

Deno.test("hosted principal factory: metadata and a login cannot replace App/source/execution proof", async (t) => {
  for (
    const scenario of [
      "no App",
      "native fallback",
      "no metadata",
      "no window",
      "expired",
      "completed native job",
      "unhealthy",
      "pointer moved",
      "wrong launcher code",
      "release race",
    ]
  ) {
    await t.step(scenario, async () => {
      const rig = await principalHostFixture();
      try {
        if (scenario === "no App") rig.hostInput.appToken = undefined;
        else if (scenario === "native fallback") {
          rig.hostInput.appToken = rig.hostInput.nativeToken;
        } else if (scenario === "no metadata") {
          rig.hostInput.mintGrant = undefined;
        } else if (scenario === "no window") {
          rig.hostInput.appTokenNotAfter = undefined;
        } else if (scenario === "expired") {
          rig.hostInput.appTokenNotAfter = String(OBSERVED);
        } else if (scenario === "completed native job") {
          rig.model.jobs[0].status = "completed";
        } else if (scenario === "wrong launcher code") {
          rig.profiles[0].codeSha256 = "0".repeat(64);
        } else {
          const release = rig.state.release!.snapshot as {
            hostedRuntimes: Array<
              { activeRevision: string; lastHealthyProof: unknown }
            >;
          };
          if (scenario === "unhealthy") {
            release.hostedRuntimes[0].lastHealthyProof = null;
          } else if (scenario === "pointer moved") {
            release.hostedRuntimes[0].activeRevision = "f".repeat(40);
          } else {
            let reads = 0;
            const read = rig.state.readRelease.bind(rig.state);
            rig.state.readRelease = () => {
              if (++reads > 1) {
                rig.state.release!.head = "f".repeat(
                  40,
                ) as typeof rig.execution.revision;
              }
              return read();
            };
          }
        }
        assert.equal(
          await createHostedAppPrincipalContext(rig.hostInput, rig.profiles),
          null,
        );
        assert.equal(rig.state.repairWrites, 0);
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("hosted principal factory: retired custody floors do not replace exact source and execution authority", async () => {
  const rig = await principalHostFixture();
  try {
    rig.capability.existingPr.custodyActivated = false;
    await rig.write(
      rig.launcher,
      "src/host/hosted-custody-capability.json",
      JSON.stringify(rig.capability),
    );
    await rig.commitLauncher();
    assert.equal(
      await verifyHostedAppPrincipalHandoff(rig.hostInput, rig.profiles),
      true,
    );
    const context = await createHostedAppPrincipalContext(
      rig.hostInput,
      rig.profiles,
    );
    assert(context !== null);
    assert.equal(rig.state.repairWrites, 0);
  } finally {
    await rig.close();
  }
});

Deno.test("hosted principal handoff: read-only parent check and factory reject malformed authenticated rollout data", async () => {
  const rig = await principalHostFixture();
  try {
    const handoff = {
      ...rig.hostInput,
      state: { readRelease: rig.state.readRelease.bind(rig.state) },
    };
    assert.equal(await verifyHostedAppPrincipalHandoff(handoff), false);
    assert.equal(
      await verifyHostedAppPrincipalHandoff(handoff, rig.profiles),
      true,
    );
    assert.equal(rig.state.repairWrites, 0);
    // This data is excluded from the frozen code hash, so commit it into a new
    // native launcher and keep every other exact source/execution proof valid.
    const path = "src/host/hosted-runtime-rollout.json";
    const original = await Deno.readTextFile(`${rig.launcher}/${path}`);
    await rig.write(
      rig.launcher,
      path,
      JSON.stringify({ ...JSON.parse(original), unrecognizedAuthority: true }),
    );
    await rig.commitLauncher();
    const source = await readHostedAppSourceEvidence(rig.source, rig.profiles);
    assert(source !== null, "the changed data still has native source proof");
    assert.equal(source.codeSha256, rig.profiles[0].codeSha256);
    assert.equal(
      await verifyHostedAppPrincipalHandoff(handoff, rig.profiles),
      false,
    );
    assert.equal(
      await createHostedAppPrincipalContext(rig.hostInput, rig.profiles),
      null,
    );
    await rig.write(rig.launcher, path, original);
    await rig.commitLauncher();
    assert.equal(
      await verifyHostedAppPrincipalHandoff(handoff, rig.profiles),
      true,
      "only restoring valid authenticated data restores the read-only check",
    );
    assert.equal(rig.state.repairWrites, 0);
  } finally {
    await rig.close();
  }
});

Deno.test("hosted principal factory: real REST and Git composition capture the same App token and reject substitutions", async () => {
  const rig = await principalHostFixture();
  const candidate = await makeCandidateCtx();
  const OriginalCommand = Deno.Command;
  try {
    const nativeHttp = rig.hostInput.http;
    let appReads = 0;
    rig.hostInput.http = (request) => {
      if (
        new URL(request.url).pathname.endsWith("/git/ref/heads/development")
      ) {
        assert.equal(
          request.headers.get("authorization"),
          `Bearer ${rig.scopeInput.token}`,
        );
        appReads++;
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: JSON.stringify({
            ref: "refs/heads/development",
            object: { type: "commit", sha: rig.execution.revision },
          }),
        });
      }
      return nativeHttp(request);
    };
    const context = await createHostedAppPrincipalContext(
      rig.hostInput,
      rig.profiles,
    );
    assert(context !== null);
    const input = {
      invocationId: "principal-fixture",
      stateRoot: rig.root,
      sourcePath: `${candidate.tmp}/work`,
      scratch: rig.root,
      reviewCheckout: `${rig.root}/review`,
      reviewClientHome: `${rig.root}/review-home`,
      reviewTmpDir: `${rig.root}/review-tmp`,
      reviewDenoDir: `${rig.root}/review-deno`,
      trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      codexExecutable: "/unused/codex",
      tracker: new LocalSessionTracker(),
      repository: rig.task.repository,
      baseBranch: "development",
    };
    assert.throws(
      () =>
        composeHostedAppGitHub(
          { ...context } as HostedAppPrincipalContext,
          input,
        ),
      /context unavailable/,
    );
    assert.throws(
      () =>
        composeHostedAppGitHub(context, {
          ...input,
          repository: { ...input.repository, name: "unlisted" },
        }),
      /target unavailable/,
    );
    const injected = Object.assign(input, {
      token: "forged-credential",
      login: "attacker",
      http: () => {
        throw new Error("substituted transport");
      },
    });
    const port = composeHostedAppGitHub(context, injected);
    rig.hostInput.appToken = "changed-after-composition";
    const ref = await port.readRef("refs/heads/development");
    assert(ref.ok);
    assert.equal(appReads, 1);
    let credentialedGit = 0;
    Deno.Command = class extends OriginalCommand {
      constructor(command: string | URL, options: Deno.CommandOptions = {}) {
        const remote = "https://github.com/Ubiquity-Sentinel/sentinel.git";
        let actual = options;
        if (command === "/usr/bin/git" && options.args?.includes(remote)) {
          assert.equal(
            options.env?.GIT_CONFIG_KEY_0,
            `http.${remote}.extraheader`,
          );
          assert.equal(
            options.env?.GIT_CONFIG_VALUE_0,
            `Authorization: Basic ${
              btoa(`x-access-token:${rig.scopeInput.token}`)
            }`,
          );
          credentialedGit++;
          actual = {
            ...options,
            args: [
              "-c",
              `url.file://${candidate.bare}.insteadOf=${remote}`,
              ...options.args,
            ],
          };
        }
        super(command, actual);
      }
    };
    const pushed = await port.pushHead(
      "refs/heads/principal-fixture",
      candidate.head,
      null,
    );
    assert.deepEqual(pushed, { ok: true, value: "applied" });
    assert.equal(
      credentialedGit,
      2,
      "remote observation and ordinary guarded push use the captured same token",
    );
    const observed = await rig.git(candidate.bare, [
      "rev-parse",
      "refs/heads/principal-fixture",
    ]);
    assert.equal(observed, candidate.head);
    assert.equal(rig.state.repairWrites, 0);
  } finally {
    Deno.Command = OriginalCommand;
    await candidate.cleanup();
    await rig.close();
  }
});

Deno.test("hosted principal handoff: authenticated admission data must be present, exact and boolean", async (t) => {
  for (const shape of ["missing", "unknown", "nonboolean"]) {
    await t.step(shape, async () => {
      const rig = await principalHostFixture();
      try {
        const value: Record<string, unknown> = structuredClone(rig.capability);
        if (shape === "missing") delete value.takeover;
        else {value.takeover = shape === "unknown"
            ? { activated: false, callerOverride: true }
            : { activated: "true" };}
        await rig.write(
          rig.launcher,
          "src/host/hosted-custody-capability.json",
          JSON.stringify(value),
        );
        await rig.commitLauncher();
        const source = await readHostedAppSourceEvidence(
          rig.source,
          rig.profiles,
        );
        assert(
          source !== null,
          "the native source and code profile are authentic",
        );
        assert.equal(
          await verifyHostedAppPrincipalHandoff(rig.hostInput, rig.profiles),
          false,
        );
        assert.equal(
          await createHostedAppPrincipalContext(rig.hostInput, rig.profiles),
          null,
        );
        assert.equal(rig.state.repairWrites, 0);
      } finally {
        await rig.close();
      }
    });
  }
});
