/**
 * The hosted App principal binds a foreign target by its durable logical
 * scope (`SENTINEL_APP_INSTALLATION_ID`), never by the live credential
 * installation the grant names after an App transfer: the parse already bound
 * the grant to the expected live installation, and the native path proves the
 * repository's membership in that credential scope.
 */
import assert from "node:assert/strict";
import {
  composeHostedAppGitHub,
  createHostedAppPrincipalContext,
} from "../../src/host/hosted-app-principal.ts";
import { createActionsTargetBindings } from "../../src/host/actions-target-bindings.ts";
import {
  ACTIONS_LOGIN,
  APP_LOGIN,
} from "../../src/host/actions-target-cycles.ts";
import { LocalSessionTracker } from "../../src/host/local-client.ts";
import { makeCandidateCtx } from "./actions-candidates-fixture.ts";
import {
  principalGrant,
  principalHostFixture,
} from "./hosted-app-principal-fixtures.ts";

const LIVE_INSTALLATION = 173913802;
const DURABLE_SCOPE = 155687488;

Deno.test("hosted App principal: a live-installation grant composes the durable foreign scope only", async () => {
  const rig = await principalHostFixture();
  const candidate = await makeCandidateCtx();
  try {
    const context = await createHostedAppPrincipalContext({
      ...rig.hostInput,
      mintGrant: principalGrant({ installationId: LIVE_INSTALLATION }),
      expectedInstallationId: LIVE_INSTALLATION,
    }, rig.profiles);
    assert(context !== null, "live grant parses against its expected id");
    const input = {
      invocationId: "principal-scope-fixture",
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
      baseBranch: "development",
    };
    const durable = composeHostedAppGitHub(context, {
      ...input,
      repository: {
        owner: "ubiquity",
        name: "ai.ubq.fi",
        installationId: DURABLE_SCOPE,
      },
    });
    assert.equal(typeof durable.readRef, "function");
    assert.throws(
      () =>
        composeHostedAppGitHub(context, {
          ...input,
          repository: {
            owner: "ubiquity",
            name: "ai.ubq.fi",
            installationId: LIVE_INSTALLATION,
          },
        }),
      /target unavailable/,
    );
    assert.equal(
      await createHostedAppPrincipalContext({
        ...rig.hostInput,
        mintGrant: principalGrant({ installationId: LIVE_INSTALLATION }),
      }, rig.profiles),
      null,
      "a live grant never parses against the durable default",
    );
  } finally {
    await candidate.cleanup();
    await rig.close();
  }
});

Deno.test("hosted App principal: the child's target bindings compose the context only under the live installation", async () => {
  const rig = await principalHostFixture();
  const candidate = await makeCandidateCtx();
  try {
    const { appToken: _appToken, mintGrant: _mintGrant, ...auth } =
      rig.hostInput;
    const bindingsFor = (targetInstallationId: number) =>
      createActionsTargetBindings({
        selfRepository: {
          owner: "ubiquity-sentinel",
          name: "sentinel",
          installationId: 0,
        },
        selfToken: undefined,
        selfWriteToken: rig.jobInput.token,
        targetToken: rig.scopeInput.token,
        targetLogin: APP_LOGIN,
        actionsLogin: ACTIONS_LOGIN,
        appLogin: APP_LOGIN,
        auth,
        targetMintGrant: principalGrant({ installationId: LIVE_INSTALLATION }),
        selfMintGrant: undefined,
        targetInstallationId,
        selfInstallationId: 173834540,
        contextsAllowed: true,
        sourceProfiles: rig.profiles,
      });
    const live = await bindingsFor(LIVE_INSTALLATION);
    assert(live.targetContext !== null, "live id composes the target context");
    assert.equal(live.selfContext, null, "no self grant, no self context");
    const port = composeHostedAppGitHub(live.targetContext, {
      invocationId: "principal-bindings-fixture",
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
      repository: {
        owner: "ubiquity",
        name: "ai.ubq.fi",
        installationId: DURABLE_SCOPE,
      },
      baseBranch: "development",
    });
    assert.equal(typeof port.readRef, "function");
    const durable = await bindingsFor(DURABLE_SCOPE);
    assert.equal(
      durable.targetContext,
      null,
      "a live grant never binds under the durable default",
    );
  } finally {
    await candidate.cleanup();
    await rig.close();
  }
});
