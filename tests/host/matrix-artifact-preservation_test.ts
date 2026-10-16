/** Fresh-runner candidate preservation, bounded bundles and review correction. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { fetchHttpTransport } from "../../src/github/http.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import { ciCorrectionFinding } from "../../src/repair/ci-rejection.ts";
import {
  gitRun,
  REPO,
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";
import {
  bytes,
  digest,
  fixture,
  ISO,
  RESERVATION,
  zip,
} from "./matrix-artifact-fixtures.ts";

Deno.test("matrix artifacts: post-ingest candidate preservation hydrates on fresh runner without replay", async (t) => {
  const rig = await fixture();
  try {
    const first = await rig.transport.recover(rig.input);
    await Deno.remove(first[0].bundlesDir, { recursive: true });
    const task = rig.repair.work[0];
    const startedAt = T0 + 1_000;
    const intent = {
      kind: "candidate_preservation" as const,
      key: rig.cell.intentKey,
      startedAt,
      branch: await candidatePreservationRef(REPO, task.id, rig.cell.intentKey),
      expectedHead: rig.result.bundle!.head,
      observedBase: SHA1,
      pr: null,
      requestId: RESERVATION,
      resultId: null,
    };
    const target = {
      ...task.target,
      head: rig.result.bundle!.head,
      checkpoint: null,
      candidateState: { preserved: null, publishedHead: null },
    };
    rig.repair.work[0] = workRecord(task.id, {
      ...task,
      target,
      intent,
      updatedAt: startedAt,
    });
    rig.repair.reservations[0] = {
      ...rig.repair.reservations[0],
      outcome: "submitted",
      settledAt: startedAt,
    };
    rig.repair.updatedAt = startedAt;
    parseRepairStateSnapshotV1(rig.repair);
    const before = canonicalStringify(rig.repair);
    const recovered = await rig.transport.recover(rig.input);
    assert.equal(recovered[0].results.length, 1);
    assert.notEqual(recovered[0].bundlesDir, first[0].bundlesDir);
    assert.deepEqual(
      await Deno.readFile(
        recovered[0].bundlesDir + "/" + rig.result.bundle!.file,
      ),
      rig.bundle,
    );
    assert.equal(canonicalStringify(rig.repair), before);
    for (const outcome of ["reserved", "ambiguous"] as const) {
      await t.step(
        outcome + " cannot authorize candidate hydration",
        async () => {
          rig.repair.reservations[0].outcome = outcome;
          rig.repair.reservations[0].settledAt = outcome === "reserved"
            ? null
            : startedAt;
          await assert.rejects(() => rig.transport.recover(rig.input));
          rig.repair.reservations[0].outcome = "submitted";
          rig.repair.reservations[0].settledAt = startedAt;
        },
      );
    }
    await t.step(
      "persisted candidate mismatch refuses authentic bundle",
      async () => {
        rig.repair.work[0].target.head = SHA1;
        rig.repair.work[0].intent!.expectedHead = SHA1;
        await assert.rejects(() => rig.transport.recover(rig.input));
        rig.repair.work[0].target.head = rig.result.bundle!.head;
        rig.repair.work[0].intent!.expectedHead = rig.result.bundle!.head;
      },
    );
    await t.step("wrong preservation operation ref refuses", async () => {
      rig.repair.work[0].intent!.branch = "refs/heads/sentinel-candidates/" +
        "c".repeat(64);
      await assert.rejects(() => rig.transport.recover(rig.input));
    });
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: production artifact HTTP recovers incompressible nine MiB bundle within finite limit", async () => {
  const rig = await fixture();
  try {
    const payload = new Uint8Array(9 * 1024 * 1024);
    for (let offset = 0; offset < payload.length; offset += 65_536) {
      crypto.getRandomValues(payload.subarray(offset, offset + 65_536));
    }
    const repository = rig.tmp + "/source";
    const gitHome = rig.tmp + "/git-home";
    await Deno.mkdir(repository);
    await Deno.mkdir(gitHome);
    const environment = testGitEnv(gitHome);
    const git = async (args: string[]) => {
      const result = await gitRun(repository, args, environment);
      assert.equal(result.ok, true, result.stderr);
      return result.stdout.trim();
    };
    await git(["init", "--initial-branch", "fixture"]);
    await git(["commit", "--allow-empty", "-m", "base"]);
    const base = await git(["rev-parse", "HEAD"]) as GitSha;
    await Deno.writeFile(repository + "/blob.bin", payload);
    await git(["add", "blob.bin"]);
    await git(["commit", "-m", "candidate"]);
    const head = await git(["rev-parse", "HEAD"]) as GitSha;
    const bundlePath = rig.tmp + "/candidate.bundle";
    await git(["bundle", "create", bundlePath, "HEAD", "^" + base]);
    const bundle = await Deno.readFile(bundlePath);
    rig.cell.expectedBase = base;
    rig.cell.request.base = base;
    rig.cell.requestDigest = await matrixDigestV1(rig.cell.request);
    rig.input.requests[0].expectedBase = base;
    rig.repair.work[0].target.base = base;
    rig.repair.work[0].intent!.observedBase = base;
    rig.repair.reservations[0].head = base;
    rig.result.requestDigest = rig.cell.requestDigest;
    rig.result.bundle!.head = head;
    rig.result.receipt!.candidate!.head = head;
    rig.result.receipt!.candidate!.changedPaths = ["blob.bin"];
    rig.plannerMarker.planDigest = await matrixDigestV1(rig.plan);
    rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
    await rig.setArchive(
      501,
      rig.planName,
      await zip([
        { name: "plan.json", content: bytes(rig.plan) },
      ]),
    );
    rig.result.bundle!.digest = await digest(bundle);
    rig.cellMarker.bundleDigest = rig.result.bundle!.digest;
    rig.cellMarker.resultDigest = await matrixDigestV1(rig.result);
    rig.logs.set(402, ISO + " " + JSON.stringify(rig.cellMarker) + "\n");
    const archive = await zip([
      { name: "result.json", content: bytes(rig.result) },
      { name: rig.result.bundle!.file, content: bundle },
    ]);
    assert.ok(archive.length > 8 * 1024 * 1024);
    await rig.setArchive(502, rig.cellName, archive);
    const recovered = await rig.transport.recover(rig.input);
    const actual = await Deno.readFile(
      recovered[0].bundlesDir + "/" + rig.result.bundle!.file,
    );
    assert.equal(actual.length, bundle.length);
    assert.equal(await digest(actual), rig.result.bundle!.digest);
    await git([
      "bundle",
      "verify",
      recovered[0].bundlesDir + "/" + rig.result.bundle!.file,
    ]);
    const beforeOversize = rig.calls.length;
    rig.artifacts[1].size_in_bytes = (64 + 2 + 1) * 1024 * 1024 + 1;
    await assert.rejects(() => rig.transport.recover(rig.input));
    assert.equal(
      rig.calls.slice(beforeOversize).some((call) =>
        new URL(call.url).pathname.endsWith("/archive/502")
      ),
      false,
    );
    const ordinary = fetchHttpTransport(() =>
      Promise.resolve(new Response(bundle.slice()))
    );
    await assert.rejects(() =>
      ordinary({
        method: "GET",
        url: "https://api.github.com/archive",
        headers: new Map(),
        body: null,
        responseType: "bytes",
      })
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: review correction checkout binds prior candidate before and new candidate after ingestion", async (t) => {
  const rig = await fixture();
  try {
    const finding = {
      id: "correction-finding",
      severity: "P1",
      path: "fix.ts",
      message: "preserve requested behavior",
    };
    rig.repair.work[0].target.head = SHA2;
    rig.repair.work[0].target.pr = 12;
    rig.repair.work[0].createdAt = T0 - 10_000;
    rig.repair.reviews.push(reviewReceipt("correction-review", {
      pullRequest: { number: 12, head: SHA2, base: SHA1 },
      outcome: "completed",
      observedReviewer: "chatgpt-codex-connector[bot]",
      resultId: "correction-result",
      summary: "one required correction",
      findings: [{
        ...finding,
        fingerprint: await matrixDigestV1(finding),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P1"],
      submittedAt: T0 - 2_000,
      completedAt: T0 - 1_000,
      observedAt: T0 - 500,
    }));
    rig.cell.request.checkoutBase = SHA2;
    rig.cell.request.reviewFindings = [{
      severity: "P1",
      path: finding.path,
      message: finding.message,
    }];
    rig.cell.requestDigest = await matrixDigestV1(rig.cell.request);
    rig.result.requestDigest = rig.cell.requestDigest;
    rig.result.bundle!.head = SHA3;
    rig.result.receipt!.candidate!.head = SHA3;
    rig.plannerMarker.planDigest = await matrixDigestV1(rig.plan);
    rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
    rig.cellMarker.resultDigest = await matrixDigestV1(rig.result);
    rig.logs.set(402, ISO + " " + JSON.stringify(rig.cellMarker) + "\n");
    await rig.setArchive(
      501,
      rig.planName,
      await zip([
        { name: "plan.json", content: bytes(rig.plan) },
      ]),
    );
    await rig.setArchive(
      502,
      rig.cellName,
      await zip([
        { name: "result.json", content: bytes(rig.result) },
        { name: rig.result.bundle!.file, content: rig.bundle },
      ]),
    );
    parseRepairStateSnapshotV1(rig.repair);
    const first = await rig.transport.recover(rig.input);
    assert.equal(first[0].results[0].bundle!.head, SHA3);
    await t.step("wrong authoritative prior head refuses", async () => {
      rig.repair.work[0].target.head = SHA3;
      await assert.rejects(() => rig.transport.recover(rig.input));
      rig.repair.work[0].target.head = SHA2;
    });
    await t.step(
      "post-ingest new head does not replace prior checkout identity",
      async () => {
        const task = rig.repair.work[0];
        task.target.head = SHA3;
        task.target.candidateState = { preserved: null, publishedHead: SHA2 };
        task.intent = {
          kind: "candidate_preservation",
          key: rig.cell.intentKey,
          startedAt: T0 + 1_000,
          branch: await candidatePreservationRef(
            REPO,
            task.id,
            rig.cell.intentKey,
          ),
          expectedHead: SHA3,
          observedBase: SHA1,
          pr: null,
          requestId: RESERVATION,
          resultId: null,
        };
        rig.repair.reservations[0].outcome = "submitted";
        rig.repair.reservations[0].settledAt = T0 + 1_000;
        parseRepairStateSnapshotV1(rig.repair);
        const recovered = await rig.transport.recover(rig.input);
        assert.equal(recovered[0].results[0].bundle!.head, SHA3);
      },
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: a live-verified CI correction binds the checkout to the reviewed head", async (t) => {
  const rig = await fixture();
  // Re-bind the trusted planner's request (and every digest/marker/archive
  // over it) to the given correction findings.
  const bind = async (
    reviewFindings: {
      severity: string;
      path: string | null;
      message: string;
    }[],
  ) => {
    rig.cell.request.checkoutBase = SHA2;
    rig.cell.request.reviewFindings = reviewFindings;
    rig.cell.requestDigest = await matrixDigestV1(rig.cell.request);
    rig.result.requestDigest = rig.cell.requestDigest;
    rig.result.bundle!.head = SHA3;
    rig.result.receipt!.candidate!.head = SHA3;
    rig.plannerMarker.planDigest = await matrixDigestV1(rig.plan);
    rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
    rig.cellMarker.resultDigest = await matrixDigestV1(rig.result);
    rig.logs.set(402, ISO + " " + JSON.stringify(rig.cellMarker) + "\n");
    await rig.setArchive(
      501,
      rig.planName,
      await zip([{ name: "plan.json", content: bytes(rig.plan) }]),
    );
    await rig.setArchive(
      502,
      rig.cellName,
      await zip([
        { name: "result.json", content: bytes(rig.result) },
        { name: rig.result.bundle!.file, content: rig.bundle },
      ]),
    );
  };
  try {
    rig.repair.work[0].target.head = SHA2;
    rig.repair.work[0].target.pr = 12;
    rig.repair.work[0].createdAt = T0 - 10_000;
    // The head passed review against its base but broke a check that passed
    // there: no rejecting receipt exists and NO CI evidence is persisted. The
    // trusted planner re-derived the attribution from live check runs and
    // carried it only in its own digest-bound request.
    const accepted = reviewReceipt("accepted-review", {
      pullRequest: { number: 12, head: SHA2, base: SHA1 },
      outcome: "completed",
      observedReviewer: "chatgpt-codex-connector[bot]",
      resultId: "accepted-result",
      summary: "accepted",
      findings: [],
      unresolvedSeverities: [],
      submittedAt: T0 - 2_000,
      completedAt: T0 - 1_000,
      observedAt: T0 - 500,
    });
    rig.repair.reviews.push(accepted);
    await bind([
      ciCorrectionFinding(SHA1, [{
        name: "validate",
        status: "completed",
        conclusion: "failure",
        head: SHA2,
        startedAt: T0,
        completedAt: T0 + 1,
      }]),
    ]);
    parseRepairStateSnapshotV1(rig.repair);
    assert.deepEqual(
      Object.keys(rig.repair.work[0].target).sort(),
      ["base", "branch", "checkpoint", "head", "pr"],
      "the generation-76 target shape",
    );
    const first = await rig.transport.recover(rig.input);
    assert.equal(first[0].results[0].bundle!.head, SHA3);
    await t.step("an accepted review of another base refuses", async () => {
      rig.repair.reviews[rig.repair.reviews.length - 1] = {
        ...accepted,
        pullRequest: { ...accepted.pullRequest, base: SHA3 },
      };
      parseRepairStateSnapshotV1(rig.repair);
      await assert.rejects(() => rig.transport.recover(rig.input));
    });
    await t.step("no accepted review of the head refuses", async () => {
      rig.repair.reviews.pop();
      parseRepairStateSnapshotV1(rig.repair);
      await assert.rejects(() => rig.transport.recover(rig.input));
      rig.repair.reviews.push(accepted);
    });
    await t.step(
      "an ordinary finding on an accepted head refuses",
      async () => {
        await bind([{
          severity: "P1",
          path: null,
          message: "Required CI checks failed on this candidate: validate",
        }]);
        await assert.rejects(() => rig.transport.recover(rig.input));
      },
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
