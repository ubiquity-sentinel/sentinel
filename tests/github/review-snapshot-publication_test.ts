// review snapshot publication_test.

import assert from "node:assert/strict";
import type {
  ReplayCommandInputV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";
import { REPO, reservation, SHA1, T0, workRecord } from "../state/helpers.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { createCandidatePreserver } from "../../src/host/actions-candidates.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import {
  commitAll,
  commitIndex,
  contains,
  git,
  gitSucceeds,
  PATH,
  producer,
  publicationInput,
  seedProtectedRepo,
  seedTwoCommitRepo,
  testsDir,
  withRepo,
} from "./review-snapshot-helpers.ts";

Deno.test(
  "snapshot: diff.ignoreSubmodules=all cannot hide a gitlink change",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/account.ts`, "export const a = 1;\n");
      const base = await commitAll(repo, "base");
      // Mutable repository-local configuration attempts to hide gitlinks.
      await git(repo, ["config", "diff.ignoreSubmodules", "all"]);
      await Deno.writeTextFile(`${repo}/account.ts`, "export const a = 2;\n");
      await Deno.writeTextFile(`${repo}/extra.ts`, "export const b = 1;\n");
      await git(repo, ["add", "-A"]);
      await git(repo, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${base},vendor`,
      ]);
      const head = await commitIndex(repo, "mixed regular file and gitlink");
      const capture = await producer(repo).capture({ base, head });
      assert.ok(!capture.ok, "an ignored gitlink change must be unavailable");
      if (capture.ok) assert.fail("expected rejection");
      assert.equal(capture.error.kind, "unavailable");
      contains(capture.error.detail, "submodule");
    });
  },
);

Deno.test(
  "snapshot: forced-text attributes cannot hide deleted or replaced binaries",
  async () => {
    // NUL-carrying but UTF-8-valid bytes: once the textual-diff attribute
    // disables the numstat heuristic, only the exact blob inspection rejects
    // this content.
    const BINARY = new Uint8Array([0x61, 0x00, 0x62, 0x0a]);

    // A deleted old binary blob forced to a textual diff by `.gitattributes`.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/.gitattributes`, "*.bin diff\n");
      await Deno.writeTextFile(`${repo}/keep.ts`, "export const a = 1;\n");
      await Deno.writeFile(`${repo}/payload.bin`, BINARY);
      const base = await commitAll(repo, "base");
      await Deno.remove(`${repo}/payload.bin`);
      const head = await commitAll(repo, "delete binary");
      const forced = await git(repo, [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        `${base}...${head}`,
      ]);
      assert.equal(
        forced.includes("-\t-"),
        false,
        "the fixture genuinely bypasses the numstat binary heuristic",
      );
      const capture = await producer(repo).capture({ base, head });
      assert.ok(
        !capture.ok,
        "a forced-text deleted binary must be unavailable",
      );
      if (capture.ok) assert.fail("expected rejection");
      assert.equal(capture.error.kind, "unavailable");
      contains(capture.error.detail, "binary");
    });

    // A replaced old binary blob forced to a textual diff by `.gitattributes`.
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/.gitattributes`, "*.bin diff\n");
      await Deno.writeTextFile(`${repo}/keep.ts`, "export const a = 1;\n");
      await Deno.writeFile(`${repo}/payload.bin`, BINARY);
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(
        `${repo}/payload.bin`,
        "export const replaced = 1;\n",
      );
      await Deno.writeTextFile(`${repo}/keep.ts`, "export const a = 2;\n");
      const head = await commitAll(repo, "replace binary");
      const forced = await git(repo, [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        `${base}...${head}`,
      ]);
      assert.equal(
        forced.includes("-\t-"),
        false,
        "the fixture genuinely bypasses the numstat binary heuristic",
      );
      const capture = await producer(repo).capture({ base, head });
      assert.ok(
        !capture.ok,
        "a forced-text replaced binary must be unavailable",
      );
      if (capture.ok) assert.fail("expected rejection");
      contains(capture.error.detail, "binary");
    });
  },
);

Deno.test(
  "snapshot: a missing promisor blob is never lazily fetched",
  async () => {
    const source = await Deno.makeTempDir({
      prefix: ".review-snapshot-src-",
      dir: testsDir,
    });
    const partial = await Deno.makeTempDir({
      prefix: ".review-snapshot-partial-",
      dir: testsDir,
    });
    try {
      await git(source, ["init", "-q"]);
      await git(source, [
        "config",
        "user.email",
        "sentinel-test@example.invalid",
      ]);
      await git(source, ["config", "user.name", "Sentinel Test"]);
      await git(source, ["config", "uploadpack.allowFilter", "true"]);
      await Deno.writeTextFile(`${source}/account.ts`, "export const a = 1;\n");
      const base = await commitAll(source, "base");
      await Deno.writeTextFile(`${source}/account.ts`, "export const a = 2;\n");
      await Deno.writeTextFile(`${source}/added.ts`, "export const b = 2;\n");
      const head = await commitAll(source, "head");
      const blob = (await git(source, ["rev-parse", `${head}:account.ts`]))
        .trim();
      await git(partial, [
        "clone",
        "-q",
        "--filter=blob:none",
        "--no-checkout",
        `file://${source}`,
        ".",
      ]);
      assert.equal(
        await gitSucceeds(partial, ["cat-file", "-e", blob]),
        false,
        "the fixture must not contain the promisor blob",
      );
      const capture = await producer(partial).capture({ base, head });
      assert.ok(!capture.ok, "a missing promisor object must fail closed");
      if (capture.ok) assert.fail("expected rejection");
      assert.equal(capture.error.kind, "unavailable");
      assert.equal(
        await gitSucceeds(partial, ["cat-file", "-e", blob]),
        false,
        "no lazy fetch may materialize the missing blob",
      );
    } finally {
      await Deno.remove(source, { recursive: true }).catch(() => {});
      await Deno.remove(partial, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "snapshot: trusted child controls disable lazy fetch, protocols and helpers",
  async () => {
    await withRepo(async (repo) => {
      const { base, head } = await seedTwoCommitRepo(repo);
      const calls: ReplayCommandInputV1[] = [];
      const recording: ReplayRuntimeV1 = {
        run: (input) => {
          calls.push(input);
          return Promise.resolve({
            outcome: "spawn_failed",
            exitCode: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            truncated: false,
            settled: true,
            detail: "recorded",
          });
        },
      };
      const capture = await producer(repo, { runtime: recording }).capture({
        base,
        head,
      });
      assert.ok(!capture.ok, "a spawn failure must fail closed");
      assert.ok(
        calls.length >= 1,
        "at least one trusted Git read was attempted",
      );
      for (const call of calls) {
        assert.equal(call.env.GIT_NO_LAZY_FETCH, "1");
        assert.equal(call.env.GIT_ALLOW_PROTOCOL, "");
        assert.equal(call.env.GIT_TERMINAL_PROMPT, "0");
        let clearedHelper = false;
        for (let index = 0; index + 1 < call.args.length; index++) {
          if (
            call.args[index] === "-c" &&
            call.args[index + 1] === "credential.helper="
          ) {
            clearedHelper = true;
          }
        }
        assert.ok(clearedHelper, "the fixed argv clears credential.helper");
      }
    });
  },
);

Deno.test(
  "publication: an ordinary clean candidate passes the negative check",
  async () => {
    await withRepo(async (repo) => {
      const base = await seedProtectedRepo(repo);
      await Deno.writeTextFile(`${repo}/public.txt`, "public v2\n");
      await Deno.writeTextFile(`${repo}/added.txt`, "added v1\n");
      const head = await commitAll(repo, "candidate change");

      const clean = await producer(repo).validatePublication(
        publicationInput(base, head, { protectedPaths: ["protected/"] }),
      );
      assert.ok(clean.ok, clean.ok ? "" : clean.error.detail);
      if (!clean.ok) assert.fail("expected a clean candidate to pass");
      assert.equal(clean.value, undefined);

      const unprotected = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(
        unprotected.ok,
        unprotected.ok ? "" : unprotected.error.detail,
      );

      const stale = await producer(repo).validatePublication(
        publicationInput(head, base),
      );
      assert.ok(!stale.ok, "a nonintegrated base must reject");
      if (stale.ok) assert.fail("expected rejection");
      contains(stale.error.detail, "ancestor");

      const unchanged = await producer(repo).validatePublication(
        publicationInput(base, base),
      );
      assert.ok(!unchanged.ok, "an unchanged head must reject");
      if (unchanged.ok) assert.fail("expected rejection");
      contains(unchanged.error.detail, "no new commit");
    });
  },
);

Deno.test(
  "publication: a secret-shaped intermediate blob is never hidden",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed\n");
      const base = await commitAll(repo, "base");
      await Deno.writeTextFile(
        `${repo}/token.txt`,
        `token ghp_${"A".repeat(30)}\n`,
      );
      await commitAll(repo, "add secret-shaped material");
      await Deno.remove(`${repo}/token.txt`);
      const head = await commitAll(repo, "remove it again");

      const result = await producer(repo).validatePublication(
        publicationInput(base, head),
      );
      assert.ok(!result.ok, "an intermediate secret-shaped blob must reject");
      if (result.ok) assert.fail("expected rejection");
      contains(result.error.detail, "secret-shaped");
    });
  },
);

Deno.test(
  "lifecycle105: real metadata refusal settles preservation while a failed Git process retains its bounded retry",
  async (test) => {
    for (const boundary of ["metadata", "process"] as const) {
      await test.step(boundary, async () => {
        await withRepo(async (repo) => {
          await Deno.writeTextFile(
            `${repo}/candidate.ts`,
            "export const fixed = false;\n",
          );
          const base = await commitAll(repo, "base");
          await Deno.writeTextFile(
            `${repo}/candidate.ts`,
            "export const fixed = true;\n",
          );
          const head = await commitAll(repo, "Fixes #105");
          const stateRemote = `${repo}/state.git`;
          await git(repo, ["init", "-q", "--bare", stateRemote]);
          const state = createRepairStateStore({
            scratchDir: `${repo}/state-scratch`,
            remoteUrl: stateRemote,
          });
          const clock = new FakeClock(T0);
          const id = asWorkItemId("issue-105");
          const reservationId = "bd".repeat(32);
          const operationKey = implementationIntentKey(reservationId);
          const ref = await candidatePreservationRef(REPO, id, operationKey);
          const record = workRecord(id, {
            source: { kind: "issue", id: "105", revision: SHA1 },
            related: { incidentId: null, issueNumber: 105 },
            target: {
              base,
              branch: candidateBranch(id),
              checkpoint: { branch: candidateBranch(id), sha: head },
              head,
              pr: 7,
              candidateState: { preserved: null, publishedHead: base },
            },
            nextStep: "work",
            counters: { attempts: 1, retries: 0, reviewRounds: 0 },
            intent: {
              kind: "candidate_preservation",
              key: operationKey,
              startedAt: T0,
              branch: ref,
              expectedHead: head,
              observedBase: base,
              pr: null,
              requestId: reservationId,
              resultId: null,
            },
          });
          const charge = reservation(reservationId, {
            repository: REPO,
            taskId: id,
            attempt: 1,
            head: base,
            purpose: "implementation",
            outcome: "submitted",
            settledAt: T0,
          });
          const seeded = await state.writeRepair(
            parseRepairStateSnapshotV1({
              version: "v1",
              kind: "repair_state_snapshot",
              stateHead: null,
              sequence: 1,
              updatedAt: T0,
              incidents: [],
              evidence: [],
              work: [record],
              reservations: [charge],
              reviews: [],
              replays: [],
              releaseRequests: [],
              githubCooldowns: [],
              attemptMemory: [],
              lessons: [],
            }),
            null,
          );
          assert.ok(seeded.ok && seeded.value.status === "applied");
          const gate = new DurableGitHubCooldownGate({ state, clock });
          const github = new FakeGithub({
            baseSha: base,
            openIssues: [],
            candidateLifecycle: {
              refs: {
                [ref]: null,
                [`refs/heads/${candidateBranch(id)}`]: base,
              },
            },
          });
          const preserve = createCandidatePreserver({
            state,
            gate,
            token: "fixture-token",
            http: () => {
              throw new Error("unexpected HTTP transport");
            },
            clock,
            sourcePath: repo,
            repository: REPO,
            scratch: `${repo}/proof`,
            trustedPath: PATH,
            gitExecutable: boundary === "metadata" ? "git" : "/usr/bin/false",
            remoteUrl: `file://${repo}`,
            port: github,
            protectedPaths: [],
            ensureLocalCandidate: async (_taskId, requestedHead) => {
              assert.equal(
                (await git(repo, ["rev-parse", `${requestedHead}^{commit}`]))
                  .trim(),
                head,
              );
              return portOk(undefined);
            },
          });
          let preservationCalls = 0;
          github.preserveCandidate = async (request) => {
            preservationCalls++;
            const result = await preserve(request);
            assert.equal(result.ok, false);
            if (!result.ok) {
              assert.equal(
                result.error.kind,
                boundary === "metadata" ? "invalid" : "unavailable",
              );
            }
            if (!result.ok && boundary === "metadata") {
              contains(
                result.error.detail,
                "issue-closing",
                "the real preserver must reach the deterministic metadata predicate",
              );
            }
            return result;
          };
          const configs = repairConfigs({
            adapter: { kind: "github" },
            protectedPaths: [],
          });
          const model = new FakeModel();
          const run = () =>
            runRepairCycle({
              clock,
              state,
              configs,
              controllerSha: SHA1,
              github,
              githubCooldown: gate,
              incidents: new FakeIncidents({ summaries: [], evidence: null }),
              replay: new FakeReplay(),
              model,
              budget: new RollingStartBudget({ clock, state, configs }),
            }, {
              deadline: clock.now() + 60 * 60_000,
              stepLimit: 4,
              modelStartsEnabled: false,
            });
          await run();
          const read = await state.readRepair();
          assert.ok(read.ok && read.value.status === "found");
          if (!read.ok || read.value.status !== "found") {
            throw new Error("missing fixture state");
          }
          const result = read.value.snapshot.work[0]!;
          assert.equal(preservationCalls, 1);
          assert.deepEqual(
            result.target,
            record.target,
            "immutable candidate and publication identities remain exact",
          );
          assert.deepEqual(
            read.value.snapshot.reservations,
            [charge],
            "the original submitted attempt stays charged",
          );
          assert.equal(model.requests.length, 0);
          assert.equal(github.pushes.length, 0);
          if (boundary === "metadata") {
            assert.equal(
              result.nextStep,
              "blocked",
              "a proved immutable metadata refusal must not retry forever",
            );
            assert.equal(result.intent, null);
            assert.equal(result.wait, null);
          } else {
            assert.equal(result.nextStep, "work");
            assert.deepEqual(result.intent, record.intent);
            assert.equal(result.wait?.reason, "unavailable");
            assert.equal(result.wait?.until, T0 + 5 * 60_000);
          }
          clock.advance(5 * 60_000 + 1);
          await run();
          assert.equal(
            preservationCalls,
            boundary === "metadata" ? 1 : 2,
            "only transport uncertainty is observed again",
          );
        });
      });
    }
  },
);

Deno.test(
  "publication: issue-closing commit metadata rejects every ordinary form",
  async () => {
    await withRepo(async (repo) => {
      await Deno.writeTextFile(`${repo}/seed.txt`, "seed 0\n");
      const base = await commitAll(repo, "base");
      const forms = [
        "fix #12",
        "fixes: #34",
        "Fixes owner/repo#56",
        "closed: https://github.com/owner/repo/issues/78",
        "resolved https://github.com/owner/repo/issues/90",
      ];
      for (let index = 0; index < forms.length; index++) {
        // Each form is one fresh candidate commit on top of the base, so the
        // newly exposed set under test is exactly that commit.
        await git(repo, ["checkout", "-q", "-B", `form-${index}`, base]);
        await Deno.writeTextFile(`${repo}/seed.txt`, `seed ${index + 1}\n`);
        const form = forms[index];
        const head = await commitAll(repo, form);
        const result = await producer(repo).validatePublication(
          publicationInput(base, head),
        );
        assert.ok(!result.ok, `issue-closing metadata must reject: ${form}`);
        if (result.ok) assert.fail("expected rejection");
        assert.equal(result.error.kind, "invalid");
        contains(result.error.detail, "issue-closing");
      }
    });
  },
);
