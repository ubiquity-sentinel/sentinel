/**
 * An unavailable observation of a legacy record's published predecessor is
 * never stored as a verified absent head (issue #103): the record keeps its
 * legacy shape, and its publication re-observes the branch, so the legitimate
 * predecessor ref is leased instead of being refused as an unrelated head.
 */
import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  CalendarCiMinutes,
  proposedCiMinutePolicy,
} from "../../src/budget/ci-minutes.ts";
import {
  type CiMinuteLedgerV1,
  ciMonth,
  ciPolicyDigest,
} from "../../src/contracts/ci-minute-budget.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { GitReviewSnapshot } from "../../src/github/review-snapshot.ts";
import { createPrivateCiEffectResolver } from "../../ops/hosted-autonomy-github-jobs.ts";
import {
  issueRecord,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import {
  LEGACY_B0,
  LEGACY_BRANCH,
  LEGACY_H0,
  LEGACY_ISSUE,
  LEGACY_PR,
  LEGACY_REVIEW_ID,
  legacyLossCharge,
  legacyLossCycles,
  legacyLossReview,
  legacyLossWork,
} from "./loop-legacy-fixtures.ts";

Deno.test(
  "CI round2 legacy producer keeps an unavailable predecessor then qualifies its unpublished local head before recovered publication",
  async () => {
    await Deno.mkdir(".data/ci-minute-tests", { recursive: true });
    const local = await Deno.realPath(
      await Deno.makeTempDir({
        dir: ".data/ci-minute-tests",
        prefix: "synthetic-legacy-",
      }),
    );
    const trustedPath = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    const git = async (...args: string[]) => {
      const result = await new Deno.Command("git", {
        args,
        cwd: local,
        clearEnv: true,
        env: {
          PATH: trustedPath,
          HOME: local,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "synthetic",
          GIT_AUTHOR_EMAIL: "synthetic@localhost",
          GIT_COMMITTER_NAME: "synthetic",
          GIT_COMMITTER_EMAIL: "synthetic@localhost",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.ok(result.success, new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout).trim();
    };
    await git("init", "-q");
    await Deno.mkdir(`${local}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${local}/.github/workflows/ci.yml`,
      "on: [pull_request]\njobs:\n  validation:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - run: true\n",
    );
    await Deno.mkdir(`${local}/src`);
    await Deno.writeTextFile(
      `${local}/src/app.ts`,
      "export const synthetic = true;\n",
    );
    await git("add", "-A");
    await git("commit", "-q", "-m", "synthetic local candidate");
    const produced = await git("rev-parse", "HEAD") as GitSha;
    const workflow = await git(
      "rev-parse",
      `${produced}:.github/workflows/ci.yml`,
    );
    // The owned candidate branch exists at the legacy predecessor head H0.
    const port = new RelationsFakeGithub({
      baseSha: LEGACY_B0,
      branchRefSha: LEGACY_H0,
    });
    const rig = await makeRig("legacy-observation", {
      summaries: false,
      localScope: true,
      githubPort: port,
      model: { head: produced },
    });
    try {
      // A legacy record (no V1 candidate state) whose published head H0 was
      // rejected by review, so the next attempt corrects it.
      const record = legacyLossWork("issue-48", LEGACY_ISSUE, {
        target: {
          base: LEGACY_B0,
          branch: LEGACY_BRANCH,
          checkpoint: null,
          head: LEGACY_H0,
          pr: LEGACY_PR,
        },
        intent: null,
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([record], {
          reservations: [legacyLossCharge()],
          reviews: [legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0)],
        }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      port.latest.set(
        LEGACY_ISSUE,
        issueRecord(LEGACY_ISSUE, {
          relations: { subIssueCount: 0, openBlockers: [] },
        }),
      );

      // The predecessor observation after the model run is unavailable.
      let unavailable = true;
      const readRef = port.readRef.bind(port);
      port.readRef = (ref) =>
        unavailable && rig.model.requests.length > 0 &&
          ref === `refs/heads/${LEGACY_BRANCH}`
          ? Promise.resolve(portError("unavailable", "ref read unavailable"))
          : readRef(ref);

      const policy = {
        ...proposedCiMinutePolicy(),
        activated: true,
        storageAcceptance: "a".repeat(64),
        ceilingQualification: "b".repeat(64),
        targets: [{
          owner: record.repository.owner,
          name: record.repository.name,
          repositoryId: 101,
          ceilingMinutes: 25,
        }],
      };
      let ciLedger: CiMinuteLedgerV1 = {
        version: 1,
        month: ciMonth(rig.clock.now()).month,
        policyDigest: ciPolicyDigest(policy),
        updatedAt: rig.clock.now(),
        sequence: 0,
        baselineMinutes: 0,
        watermark: null,
        reservations: [],
        observed: [],
      };
      let head = "1".repeat(40) as GitSha, sequence = 1, preparedReads = 0;
      const view = new GitReviewSnapshot({
        repositoryDir: local,
        trustedPath,
        now: () => rig.clock.now(),
      });
      const ciMinutes = new CalendarCiMinutes({
        policy,
        clock: rig.clock,
        authorizePolicy: (basis, _deadline, facts) =>
          Promise.resolve(
            ciPolicyDigest(basis) === ciPolicyDigest(policy) &&
              (facts === undefined ||
                facts.workflowBlob === workflow && facts.job === "validation" &&
                  facts.runner === "ubuntu-latest" &&
                  facts.timeoutMinutes === 20 && facts.jobs === 1),
          ),
        resolve: createPrivateCiEffectResolver({
          policy,
          request: async (path) => {
            assert.equal(
              path.includes("/contents/"),
              false,
              "unpublished local head must not require remote Contents",
            );
            if (path.includes("/git/ref/")) {
              const ref = await port.readRef(`refs/heads/${LEGACY_BRANCH}`);
              return ref.ok && ref.value
                ? { object: { sha: ref.value.sha } }
                : null;
            }
            return { id: 101, private: true, default_branch: "development" };
          },
          readPreparedWorkflow: (effect, deadline) => {
            preparedReads++;
            assert.equal(effect.head, produced);
            return view.readWorkflowBlob(effect.head as GitSha, deadline);
          },
        }),
        observe: (month) =>
          Promise.resolve({
            month,
            complete: true,
            watermark: rig.clock.now(),
            jobs: [],
          }),
        store: {
          read: () =>
            Promise.resolve(
              portOk({ head, ledger: structuredClone(ciLedger) }),
            ),
          readPrior: () => Promise.resolve(portOk({ head, ledger: null })),
          write(input) {
            assert.equal(input.expectedHead, head);
            ciLedger = structuredClone(input.ledger);
            head = String(++sequence).padStart(40, "0") as GitSha;
            return Promise.resolve(
              portOk({ status: "applied" as const, head: head }),
            );
          },
        },
      });
      const push = port.pushHead.bind(port);
      port.pushHead = (...args: Parameters<typeof port.pushHead>) => {
        assert.equal(
          ciLedger.reservations.length,
          1,
          "reservation precedes publication",
        );
        assert.equal(ciLedger.reservations[0].chargedMinutes, 25);
        return push(...args);
      };

      const { run } = legacyLossCycles({
        clock: rig.clock,
        state: rig.store,
        github: port,
        incidents: rig.incidents,
        replay: rig.replay,
        model: rig.model,
      }, ciMinutes);
      rig.clock.advance(2000);
      const implemented = await run(1);
      assert.equal(
        implemented.status,
        "step_limit",
        JSON.stringify(implemented),
      );
      assert.equal(rig.model.requests.length, 1);
      assert.equal(rig.model.requests[0]!.checkoutBase, LEGACY_H0);

      const noted = (await rig.snapshot()).work[0]!;
      const candidateHead = noted.target.head;
      assert.ok(
        candidateHead !== null && candidateHead !== LEGACY_H0,
        "the new candidate is noted",
      );
      // Never persisted as a verified absent predecessor: no V1 candidate
      // state and no preservation intent were written on an unverified read.
      assert.equal(noted.target.candidateState, undefined);
      assert.equal(noted.intent, null);
      assert.equal(noted.nextStep, "work");
      assert.equal(noted.blocker, null);

      // Reads recover: publication re-observes the owned branch and leases the
      // exact predecessor head instead of refusing it as an unrelated head.
      unavailable = false;
      await run(1);
      const after = (await rig.snapshot()).work[0]!;
      assert.notEqual(after.nextStep, "blocked", JSON.stringify(after.blocker));
      assert.deepEqual(port.pushes, [{
        ref: `refs/heads/${LEGACY_BRANCH}`,
        sha: candidateHead,
        expected: LEGACY_H0,
      }]);
      assert.ok(preparedReads > 0);
      assert.equal(ciLedger.reservations.length, 1);
      assert.equal(ciLedger.reservations[0].chargedMinutes, 25);
      await run(1);
      assert.equal(port.pushes.length, 1, "no duplicate recovered publication");
      assert.equal(ciLedger.reservations.length, 1, "no duplicate charge");
      assert.equal(
        rig.model.requests.length,
        1,
        "the retained candidate is not regenerated by a second model call",
      );
    } finally {
      await rig.ctx.cleanup();
      await Deno.remove(local, { recursive: true });
    }
  },
);
