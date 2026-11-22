/**
 * A repository that left the committed setting keeps its records exactly as
 * they are (2026-11-22, docs/DECISIONS.md): `ubiquity/passport.ubq.fi` no
 * longer exists under that name, and the state still holds its work rows and
 * receipts.
 *
 * - Runtime: the shipped setting does not name it, so target load never reads
 *   it and configures nothing for it; every record of it ranks `unconfigured`
 *   (or `blocked`), and real repair cycles leave its rows byte-identical with
 *   no GitHub call naming them.
 * - Launcher: the production gate composition reads the repository once per
 *   run on the launcher surface, as before. The name is gone (and is outside
 *   the minted token), so that read answers 404: the surface answers null, the
 *   visibility is unknown and the repository is hidden. The view still parses
 *   (no `view_invalid`), a write through it gets the hidden rows back
 *   byte-identical and in place, the repository has no surface, and nothing
 *   reads it again in the run. The full launcher run over an unknown
 *   visibility is `hosted-autonomy-private-targets_test.ts`.
 */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { createLocalRepositoryConfig } from "../../src/host/local.ts";
import {
  loadTargetConfigsV1,
  readTargetSlugsV1,
} from "../../src/host/targets.ts";
import { rankEligibleWork } from "../../src/repair/selection.ts";
import { resolveSentinelHostV1 } from "../../src/repair/target-visibility.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import {
  checkPrivateTargetViewV1,
  createPrivateTargetGateV1,
  gateHostedAutonomyDepsV1,
} from "../../ops/hosted-autonomy-private-targets.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  BASE,
  blockedRecord,
  foreignReceipt,
  foreignRecord,
  HEAD,
} from "./hosted-autonomy-fixtures.ts";
import { MemoryState } from "../repair/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "../repair/loop-rig.ts";

const REMOVED: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 7,
};
const SLUG = `${REMOVED.owner}/${REMOVED.name}`;

function removedRecord(
  issue: number,
  pr: number,
  extra: Record<string, unknown> = {},
): WorkRecordV1 {
  const id = `issue-ubiquity-passport.ubq.fi-${issue}` as WorkItemId;
  const record = foreignRecord();
  return foreignRecord({
    repository: REMOVED,
    id,
    source: {
      kind: "issue",
      id: String(issue),
      revision: record.source.revision,
    },
    related: { incidentId: null, issueNumber: issue },
    target: { ...record.target, branch: `sentinel/repair/${id}`, pr },
    ...extra,
  });
}

/** At delivery with a clean review, waiting on CI, and blocked. */
const RECORDS = [
  removedRecord(183, 454),
  removedRecord(184, 455),
  removedRecord(185, 456, {
    nextStep: "blocked",
    blocker: blockedRecord().blocker,
  }),
];
const RECEIPTS = [454, 455].map((number, index) =>
  foreignReceipt({
    id: `review-receipt:${String(index + 7).repeat(64)}`,
    repository: REMOVED,
    pullRequest: { number, head: HEAD, base: BASE },
  })
);

function seeded(work: WorkRecordV1[], reviews: unknown[]) {
  return seededSnapshot(
    work,
    { reviews } as unknown as Partial<RepairStateSnapshotV1>,
  );
}

/** The removed repository's rows, canonical, in state order. */
function removedRows(snapshot: RepairStateSnapshotV1) {
  const named = (row: { repository: { name: string } }) =>
    row.repository.name === REMOVED.name;
  return {
    work: snapshot.work.filter(named).map((row) => canonicalStringify(row)),
    reviews: snapshot.reviews.filter(named).map((row) =>
      canonicalStringify(row)
    ),
    reservations: snapshot.reservations.filter(named).length,
    attemptMemory: snapshot.attemptMemory.filter(named).length,
  };
}

Deno.test("removed target (runtime): the shipped setting never reads or configures it, and its records rank unconfigured", async () => {
  const listed = (await readTargetSlugsV1()).map((target) => target.slug);
  assert.equal(listed.includes(SLUG), false, "the vanished name is gone");
  const asked: string[] = [];
  const loaded = await loadTargetConfigsV1({
    template: createLocalRepositoryConfig(),
    resolveRepository: (target) => {
      asked.push(target.slug);
      return Promise.resolve({ defaultBranch: "main", visibility: "public" });
    },
  });
  // One repository read per listed target; none for the removed one, which
  // is neither skipped, private nor unavailable: it is simply not a target.
  assert.deepEqual(asked, listed);
  assert.equal(loaded.configs.length, listed.length);
  assert.equal(
    loaded.configs.some((config) => config.repository.name === REMOVED.name),
    false,
  );
  for (
    const list of [
      loaded.skipped,
      loaded.privateTargets,
      loaded.factsUnavailable,
    ]
  ) assert.equal(list.includes(SLUG), false);
  const snapshot = seeded(RECORDS, RECEIPTS);
  const ranked = rankEligibleWork(snapshot, loaded.configs, snapshot.updatedAt);
  for (const record of RECORDS) {
    assert.equal(ranked.ordered.includes(record.id), false, record.id);
  }
  assert.equal(ranked.skipped[RECORDS[0].id], "unconfigured");
  assert.equal(ranked.skipped[RECORDS[1].id], "unconfigured");
  assert.equal(ranked.skipped[RECORDS[2].id], "blocked");
});

Deno.test("removed target (runtime loop): repair cycles leave its records byte-identical and never name them on GitHub", async () => {
  const github = new RelationsFakeGithub();
  github.listed = [issueRecord(7)];
  github.latest.set(7, issueRecord(7));
  const rig = makeMemoryRig(github);
  assert.equal(
    rig.configs.some((config) => config.repository.name === REMOVED.name),
    false,
  );
  const written = await rig.state.writeRepair(seeded(RECORDS, RECEIPTS), null);
  assert.ok(written.ok && written.value.status === "applied");
  const before = await rig.snapshot();
  for (let cycle = 0; cycle < 3; cycle++) {
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    rig.clock.advance(15 * 60_000);
  }
  const after = await rig.snapshot();
  assert.deepEqual(removedRows(after), removedRows(before));
  assert.deepEqual(
    after.work.filter((row) => row.repository.name === REMOVED.name)
      .map((row) => row.id),
    RECORDS.map((row) => row.id),
  );
  for (const call of github.calls) {
    for (const number of ["454", "455", "456", "183", "184", "185"]) {
      assert.equal(
        new RegExp(`[:#/]${number}\\b`).test(call),
        false,
        `${call} names a removed-target record`,
      );
    }
  }
  // The configured target's own issue was taken in: the loop did run.
  assert.ok(
    after.work.some((row) => row.repository.name !== REMOVED.name),
    JSON.stringify(github.calls),
  );
});

Deno.test("removed target (launcher): the gate's one read answers 404, so it is hidden; the view parses, writes restore it, nothing reads it again", async () => {
  const fetched: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    return Promise.resolve(
      url === `https://api.github.com/repos/${SLUG}`
        ? new Response('{"message":"Not Found"}', { status: 404 })
        : new Response(
          '{"default_branch":"main","private":false,"visibility":"public"}',
          { status: 200 },
        ),
    );
  }) as typeof fetch;
  try {
    // The production composition (`hosted-autonomy-main.ts`): one launcher
    // surface per repository, and the host decided from the shipped setting,
    // which lists Sentinel itself, so the host is never read.
    const surfaces = new Map<string, HostedAutonomyGitHubV1>();
    const githubFor = (repository: RepositoryIdentityV1) => {
      const key = `${repository.owner}/${repository.name}`;
      const surface = surfaces.get(key) ??
        createHostedAutonomyGitHub("synthetic-token", repository);
      surfaces.set(key, surface);
      return surface;
    };
    const listed = (await readTargetSlugsV1()).map((target) => target.slug);
    const gate = createPrivateTargetGateV1({
      readVisibility: async (repository) =>
        await githubFor(repository).readVisibility?.() ?? "unknown",
      host: async () =>
        await resolveSentinelHostV1({
          repository: "ubiquity-sentinel/sentinel",
          listed,
          readVisibility: () => Promise.reject(new Error("never read")),
        }),
    });
    const state = new MemoryState();
    const publicRecord = foreignRecord();
    const raw = seeded(
      [RECORDS[0], publicRecord, RECORDS[1], RECORDS[2]],
      [RECEIPTS[0], foreignReceipt(), RECEIPTS[1]],
    );
    const seed = await state.writeRepair(raw, null);
    assert.ok(seed.ok && seed.value.status === "applied");
    const before = await state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    // The runner's own composition: gated deps, then the first-read check.
    const checked = await checkPrivateTargetViewV1(
      gateHostedAutonomyDepsV1(
        {
          privateTargets: gate,
          state,
          githubFor,
        } as unknown as HostedAutonomyDepsV1,
      ),
    );
    assert.equal(checked.invalid, false, "no view_invalid: the run goes on");
    if (checked.invalid) return;
    const deps = checked.deps;
    for (let pass = 0; pass < 2; pass++) {
      const read = await deps.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const view = read.value.snapshot;
      assert.deepEqual(view.work.map((row) => row.id), [publicRecord.id]);
      assert.deepEqual(view.reviews.map((row) => row.id), [
        foreignReceipt().id,
      ]);
      // A pass's write through the view (here: only its own sequence).
      const write = await deps.state.writeRepair({
        ...view,
        sequence: view.sequence + 1,
        updatedAt: view.updatedAt + 1,
      }, read.value.head as GitSha);
      assert.ok(write.ok && write.value.status === "applied");
    }
    const after = await state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.deepEqual(
      removedRows(after.value.snapshot),
      removedRows(before.value.snapshot),
      "its rows come back byte-identical",
    );
    assert.deepEqual(
      after.value.snapshot.work.map((row) => row.id),
      before.value.snapshot.work.map((row) => row.id),
      "and in place",
    );
    assert.equal(deps.githubFor(REMOVED), null, "no surface for it");
    assert.equal(await gate.workable(REMOVED), false);
    assert.notEqual(deps.githubFor(publicRecord.repository), null);
    // Exactly one read of it in the whole run: never retried.
    assert.deepEqual(
      fetched.filter((url) => url.includes(REMOVED.name)),
      [`https://api.github.com/repos/${SLUG}`],
    );
    assert.deepEqual(gate.line(), {
      kind: "sentinel_private_targets_hidden",
      reason: "private_repository",
      repositories: 1,
      rows: 5,
      refusedWrites: 0,
      invalidViews: 0,
    });
  } finally {
    globalThis.fetch = original;
  }
});
