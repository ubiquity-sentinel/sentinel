import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { createMaintenancePublicationFor } from "../../src/host/maintenance-existing-pr-publication.ts";
import { DEFAULT_APP_INSTALLATION_ID } from "../../src/host/actions-target-cycles.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  DenoReplayRuntime,
  type ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import { nativeLifecycleRig } from "../repair/existing-pr-lifecycle-fixtures.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import { takeoverPublicationMatches } from "../../src/github/existing-pr-publication-proof.ts";
import { commitIn, gitRun } from "./actions-candidates-fixture.ts";
import { persistTransition } from "../../src/repair/loop-state.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import { createCandidatePreserver } from "../../src/host/actions-candidates-preserve.ts";
import { FakeModel } from "../repair/helpers.ts";
import { handleModelReceipt } from "../../src/repair/loop-implementation-result.ts";
import { executeCandidatePreservation } from "../../src/repair/loop-preservation.ts";
import { executePublishStep } from "../../src/repair/loop-publication.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";

const REPOSITORY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: DEFAULT_APP_INSTALLATION_ID,
};
const REMOTE = "https://github.com/ubiquity/ai.ubq.fi.git";

async function fixture(
  createTakeover?: Parameters<typeof nativeLifecycleRig>[1],
  createPublication: typeof createMaintenancePublicationFor =
    createMaintenancePublicationFor,
) {
  const r = await nativeLifecycleRig(REPOSITORY, createTakeover);
  let context = await r.reload();
  for (let phase = 0; phase < 3; phase++) {
    const step = await routeExistingPr(
      r.deps,
      context,
      context.snapshot.work[0],
    );
    assert.ok(step.status === "step" && step.step.kind === "progress");
    context = await r.reload();
  }
  const sourceDir = `${r.ctx.tmp}/maintenance-input`;
  const scratch = `${r.ctx.tmp}/maintenance`;
  await Deno.mkdir(sourceDir, { mode: 0o700 });
  await Deno.mkdir(scratch, { mode: 0o700 });
  const targets = `${sourceDir}/sentinel.targets.json`;
  await Deno.writeTextFile(targets, JSON.stringify(["ubiquity/ai.ubq.fi"]));
  const controls = {
    missingHistory: false,
    missingRef: false,
    rateLimited: false,
    cooldown: false,
    defaultBranch: "development",
    writes: 0,
    rateWrites: 0,
  };
  const commands: { args: string[]; cwd: string }[] = [];
  const requests: Pick<HttpRequestV1, "method" | "url" | "body">[] = [];
  const native = new DenoReplayRuntime(Deno.execPath());
  const runtime: ReplayRuntimeV1 = {
    run(command) {
      commands.push({ args: command.args, cwd: command.cwd });
      assert.ok(!command.args.includes("push"));
      return native.run({
        ...command,
        args: command.args.map((arg) =>
          arg === REMOTE ? `file://${r.ctx.bare}` : controls.missingRef &&
              arg.startsWith("refs/heads/sentinel-candidates/")
            ? "refs/heads/fixture-missing-custody"
            : arg
        ),
      });
    },
  };
  const state = {
    readRepair: () => r.state.readRepair(),
    readRepairAt: (
      input: Parameters<NonNullable<typeof r.state.readRepairAt>>[0],
    ) =>
      controls.missingHistory
        ? Promise.resolve(
          portOk({
            status: "absent" as const,
            currentHead: input.expectedHead,
            ref: null,
          }),
        )
        : r.state.readRepairAt!(input),
    writeRepair: () => {
      controls.writes++;
      throw new Error("maintenance state write refused");
    },
  };
  const makeFor = () =>
    createPublication({
      sourceDir,
      scratch,
      state,
      clock: r.clock,
      token: "fixture-token",
      runtime,
      gate: {
        beforeRequest: () =>
          Promise.resolve(
            controls.cooldown
              ? portError("rate_limited", "fixture hold")
              : portOk(undefined),
          ),
        // Extra capability deliberately supplied: the adapter must not inherit it.
        ...{
          recordRateLimit: () => {
            controls.rateWrites++;
            throw new Error("maintenance cooldown write refused");
          },
        },
      },
      http: async (request) => {
        requests.push({
          method: request.method,
          url: request.url,
          body: request.body,
        });
        if (request.url === "https://api.github.com/repos/ubiquity/ai.ubq.fi") {
          return {
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify({
              default_branch: controls.defaultBranch,
            }),
          };
        }
        if (controls.rateLimited) {
          return {
            status: 429,
            headers: new Headers({ "retry-after": "60" }),
            bodyText: "{}",
          };
        }
        return await r.http(request);
      },
    });
  async function merge() {
    context = await r.reload();
    const record = context.snapshot.work[0];
    const tree = await gitRun(`${r.ctx.tmp}/work`, [
      "rev-parse",
      `${record.target.head}^{tree}`,
    ], r.ctx.env);
    assert.ok(tree.ok);
    const merged = await gitRun(`${r.ctx.tmp}/work`, [
      "commit-tree",
      tree.stdout.trim(),
      "-p",
      record.target.base,
      "-p",
      record.target.head!,
      "-m",
      "retained merge",
    ], r.ctx.env);
    assert.ok(merged.ok);
    const revision = merged.stdout.trim() as typeof r.ctx.head;
    r.nativeControls.merged = true;
    r.nativeControls.mergeSha = revision;
    r.nativeControls.issueClosed = true;
    r.nativeControls.policy.activated = false;
    r.nativeControls.fence = false;
    r.nativeControls.write = false;
    r.controls.principal = false;
    return {
      record,
      snapshot: context.snapshot,
      expectedStateHead: context.head!,
      revision,
      deadline: r.clock.now() + 240_000,
    };
  }
  return { r, controls, commands, requests, makeFor, merge, targets, scratch };
}

Deno.test("maintenance publication: real native custody reaches merged-delivery consumer without effects", async (t) => {
  // Historical direct publication keeps its genuine producer and consumer together.
  await withHostedProductionPolicy(
    DORMANT_HOSTED_SUPERVISOR_POLICY,
    async (graph) => {
      const [takeover, publication, matcher, delivery] = await Promise.all([
        graph.existingPrTakeover(),
        graph.maintenancePublication(),
        graph.publicationProof(),
        graph.deliveryFacts(),
      ]);
      const { takeoverPublicationMatches } = matcher;
      const { verifiedMergedDelivery } = delivery;
      const f = await fixture(
        takeover.createExistingPrTakeover,
        publication.createMaintenancePublicationFor,
      );
      const { r } = f;
      try {
        const request = await f.merge();
        const before = await r.reload();
        const pushes = r.pushes.length;
        const principalCalls = r.controls.principalCalls;
        const publicationFor = f.makeFor();
        assert.equal(
          publicationFor({ ...REPOSITORY, installationId: 0 }),
          undefined,
        );
        const port = publicationFor(REPOSITORY)!;
        assert.deepEqual(Object.keys(port), ["resolvePublication"]);
        assert.ok(Object.isFrozen(port));
        assert.equal(f.commands.length, 0);
        assert.equal(f.requests.length, 0);
        const proof = await port.resolvePublication(request);
        assert.ok(proof.ok, JSON.stringify(proof));
        const pull = {
          number: 7,
          state: "closed",
          merged: true,
          mergeCommitSha: request.revision,
          headSha: request.record.target.head,
          baseSha: request.record.target.base,
          baseRef: "development",
          author: "human-owner",
          parents: [request.record.target.base, request.record.target.head!],
          revisionOnBaseBranch: true,
          baseAncestorOfRevision: true,
        };
        assert.equal(
          verifiedMergedDelivery(request.record, pull, "development"),
          null,
        );
        assert.deepEqual(
          verifiedMergedDelivery(
            request.record,
            pull,
            "development",
            undefined,
            proof.value,
          ),
          { revision: request.revision },
        );
        assert.equal(
          verifiedMergedDelivery(
            request.record,
            pull,
            "development",
            undefined,
            structuredClone(proof.value),
          ),
          null,
        );
        assert.equal(request.record.target.candidateState?.preserved, null);
        assert.equal(
          f.commands.filter((command) =>
            command.args.includes("init") &&
            command.cwd.startsWith(
              `${f.scratch}/sentinel-maintenance-publication-`,
            )
          ).length,
          1,
        );
        assert.ok(f.commands.some((command) => command.args.includes(REMOTE)));
        assert.ok(
          !f.commands.some((command) => command.args.includes("clone")),
        );
        for (
          const field of ["author", "body", "head", "base", "mergeSha"] as const
        ) {
          await t.step(`changed ${field}`, async () => {
            const saved = r.nativeControls[field];
            if (field === "author") r.nativeControls.author = "different-owner";
            else if (field === "body") r.nativeControls.body = "changed issue";
            else r.nativeControls[field] = r.ctx.base;
            if (field === "base") {
              const changed = {
                ...request,
                record: {
                  ...request.record,
                  target: { ...request.record.target, base: r.ctx.head },
                },
              };
              assert.equal((await port.resolvePublication(changed)).ok, false);
            } else {assert.equal(
                (await port.resolvePublication(request)).ok,
                false,
              );}
            Object.assign(r.nativeControls, { [field]: saved });
          });
        }
        for (
          const field of [
            "missingHistory",
            "missingRef",
            "rateLimited",
          ] as const
        ) {
          await t.step(field, async () => {
            f.controls[field] = true;
            assert.equal((await port.resolvePublication(request)).ok, false);
            f.controls[field] = false;
          });
        }
        assert.equal(f.controls.writes, 0);
        assert.equal(f.controls.rateWrites, 0);
        assert.equal(r.pushes.length, pushes);
        assert.equal(r.controls.principalCalls, principalCalls);
        assert.deepEqual(await r.reload(), before);
        assert.ok(
          f.requests.every((read) =>
            read.method === "GET" ||
            (read.method === "POST" && !read.body!.includes("mutation"))
          ),
        );
        r.clock.advance(240_001);
        const counts = [f.commands.length, f.requests.length];
        assert.equal((await port.resolvePublication(request)).ok, false);
        assert.deepEqual([f.commands.length, f.requests.length], counts);
        assert.equal(
          takeoverPublicationMatches(
            proof.value,
            request.record,
            request.revision,
            "human-owner",
          ),
          false,
        );
      } finally {
        await r.ctx.cleanup();
      }
    },
  );
});

Deno.test("maintenance publication: unmarked, expired, unconfigured and cooled work cannot prepare Git", async () => {
  const f = await fixture();
  try {
    const request = await f.merge();
    const port = f.makeFor()(REPOSITORY)!;
    assert.equal(
      (await port.resolvePublication({ ...request, deadline: f.r.clock.now() }))
        .ok,
      false,
    );
    assert.equal(
      (await port.resolvePublication({
        ...request,
        record: {
          ...request.record,
          evidence: [],
          intent: null,
          blocker: null,
        },
      })).ok,
      false,
    );
    assert.equal(f.requests.length, 0);
    assert.equal(f.commands.length, 0);
    await Deno.writeTextFile(f.targets, "[]");
    assert.equal(
      (await f.makeFor()(REPOSITORY)!.resolvePublication(request)).ok,
      false,
    );
    await Deno.writeTextFile(f.targets, JSON.stringify(["ubiquity/ai.ubq.fi"]));
    f.controls.cooldown = true;
    assert.equal(
      (await f.makeFor()(REPOSITORY)!.resolvePublication(request)).ok,
      false,
    );
    assert.equal(f.requests.length, 0);
    f.controls.cooldown = false;
    f.controls.defaultBranch = "owner-branch";
    assert.equal(
      (await f.makeFor()(REPOSITORY)!.resolvePublication(request)).ok,
      false,
    );
    assert.equal(f.commands.length, 0);
    assert.equal(f.controls.writes, 0);
  } finally {
    await f.r.ctx.cleanup();
  }
});

Deno.test("maintenance publication: genuine submitted successor restores into a fresh mirror", async () => {
  const f = await fixture();
  const { r } = f;
  try {
    let context = await r.reload();
    assert.equal(
      (await persistTransition(r.deps, context, (draft) => {
        draft.reviews.push(completedReceipt(7, r.ctx.head, r.ctx.base, {
          repository: REPOSITORY,
          unresolvedSeverities: ["P1"],
          findings: [{
            id: "edge",
            severity: "P1",
            path: "candidate.txt",
            message: "Fix edge case",
            resolved: false,
            fingerprint: "b".repeat(64),
            resolutionEvidence: null,
          }],
        }));
      })).kind,
      "progress",
    );
    context = await r.reload();
    context.bounds = {
      runDeadline: r.clock.now() +
        r.deps.configs[0].sessionBound!.maxDurationMs + 7_200_000,
      modelCutoff: r.clock.now() + 5_400_000,
    };
    r.host.port.readIssue = () =>
      Promise.resolve(portOk({
        number: 1,
        title: "Repair source",
        body: r.nativeControls.body,
        state: "open",
        labels: [],
        assignees: [],
        author: "human-owner",
        createdAt: r.clock.now(),
        closedAt: null,
        updatedAt: r.clock.now(),
        relations: { subIssueCount: 0, openBlockers: [] },
      }));
    const prepared = await prepareImplementationStart(
      r.deps,
      context,
      context.snapshot.work[0],
      r.deps.configs[0],
    );
    assert.ok(prepared.kind === "prepared", JSON.stringify(prepared));
    const successor = await commitIn(
      `${r.ctx.tmp}/work`,
      r.ctx.env,
      "correction",
    );
    r.host.port.preserveCandidate = createCandidatePreserver({
      ...r.factoryInput,
      state: r.state,
      http: r.http,
      async ensureLocalCandidate(_id, head) {
        const imported = await gitRun(r.sourcePath, [
          "fetch",
          "--no-tags",
          `file://${r.ctx.tmp}/work`,
          head,
        ], r.ctx.env);
        assert.ok(imported.ok);
        return portOk(undefined);
      },
    });
    const model = new FakeModel({
      head: successor,
      changedPaths: ["correction.txt"],
    });
    const receipt = await model.runModel(prepared.request);
    assert.ok(receipt.ok);
    assert.equal(
      (await handleModelReceipt(
        r.deps,
        prepared.context,
        prepared.record,
        prepared.reservationId,
        receipt.value,
        r.deps.configs[0],
      )).kind,
      "progress",
    );
    context = await r.reload();
    assert.equal(
      (await executeCandidatePreservation(
        r.deps,
        context,
        context.snapshot.work[0],
      )).kind,
      "progress",
    );
    context = await r.reload();
    await executePublishStep(
      r.deps,
      context,
      context.snapshot.work[0],
      r.deps.configs[0],
    );
    const request = await f.merge();
    assert.equal(
      request.record.target.candidateState?.publishedHead,
      successor,
    );
    assert.equal(
      request.snapshot.reservations.find((row) =>
        row.id === prepared.reservationId
      )?.outcome,
      "submitted",
    );
    const before = await r.reload();
    const principalCalls = r.controls.principalCalls;
    const port = f.makeFor()(REPOSITORY)!;
    const proof = await port.resolvePublication(request);
    assert.ok(proof.ok, JSON.stringify(proof));
    assert.ok(
      takeoverPublicationMatches(
        proof.value,
        request.record,
        request.revision,
        "human-owner",
      ),
    );
    f.controls.missingHistory = true;
    assert.equal((await port.resolvePublication(request)).ok, false);
    assert.equal(f.controls.writes, 0);
    assert.equal(r.controls.principalCalls, principalCalls);
    assert.deepEqual(await r.reload(), before);
  } finally {
    await r.ctx.cleanup();
  }
});
