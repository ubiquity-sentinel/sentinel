/**
 * The live verify-artifact gap (sentinel issue #154), as GitHub reported it.
 *
 * ai.ubq.fi PR 1064 (issue 661): the carried head H1 f0008beb62 is the
 * runtime's deterministic base refresh of the reviewed head 3cadb582 onto the
 * tip T 9cdc76dc. Gateway CI (`.github/workflows/deno-deploy.yml`, on push to
 * `development` and on `pull_request`) runs `validate`, `mac-containment` and
 * `darwin-native`, and `verify-artifact` with `needs:` on all three, so GitHub
 * creates no `verify-artifact` check run until they finish: on H1 `validate`
 * completed at 08:41:53Z and `verify-artifact` started at 08:41:58Z. A read in
 * those five seconds saw three of three runs, all green, while the required
 * fourth job did not exist yet. T's own push run reports all four in one
 * check suite.
 *
 * The fake port's view (`SuitedCheckV1`: the strict CI read's check plus the
 * suite its coverage read reports) and the raw check-runs wire (the real
 * port's and the launcher's view) are derived from the same rows.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { checksPageWire, httpRespond, makePort } from "../github/helpers.ts";
import type { SuitedCheckV1 } from "./helpers.ts";

export const LIVE_GAP = {
  repository: "ubiquity/ai.ubq.fi",
  pr: 1064,
  issue: 661,
  reviewedHead: "3cadb582dfe4655ca51ba214dd9e79b70c0eb6d0" as GitSha,
  head: "f0008beb621a3cb8ebcbfa2779df3a34b50a2162" as GitSha,
  tip: "9cdc76dc600246d96a0841ba7fca5039cbf34196" as GitSha,
  headSuite: 105739629025,
  tipSuite: 105737343683,
} as const;

interface LiveRunV1 {
  id: number;
  name: string;
  startedAt: string;
  completedAt: string;
}

/** H1's four runs; `verify-artifact` is the one created late. */
const HEAD_RUNS: readonly LiveRunV1[] = [
  {
    id: 117351207797,
    name: "validate",
    startedAt: "2026-10-17T08:21:21Z",
    completedAt: "2026-10-17T08:41:53Z",
  },
  {
    id: 117351207884,
    name: "mac-containment",
    startedAt: "2026-10-17T08:21:23Z",
    completedAt: "2026-10-17T08:21:35Z",
  },
  {
    id: 117351207693,
    name: "darwin-native",
    startedAt: "2026-10-17T08:21:26Z",
    completedAt: "2026-10-17T08:24:19Z",
  },
  {
    id: 117354933841,
    name: "verify-artifact",
    startedAt: "2026-10-17T08:41:58Z",
    completedAt: "2026-10-17T08:42:21Z",
  },
];

/** T's four runs, one push suite. */
const TIP_RUNS: readonly LiveRunV1[] = [
  {
    id: 117348609704,
    name: "validate",
    startedAt: "2026-10-17T08:07:19Z",
    completedAt: "2026-10-17T08:27:13Z",
  },
  {
    id: 117348609609,
    name: "mac-containment",
    startedAt: "2026-10-17T08:07:23Z",
    completedAt: "2026-10-17T08:07:34Z",
  },
  {
    id: 117348609853,
    name: "darwin-native",
    startedAt: "2026-10-17T08:07:27Z",
    completedAt: "2026-10-17T08:10:01Z",
  },
  {
    id: 117352279378,
    name: "verify-artifact",
    startedAt: "2026-10-17T08:27:19Z",
    completedAt: "2026-10-17T08:27:43Z",
  },
];

/**
 * Which listing: `gap` is H1 between 08:41:53Z and 08:41:58Z (no
 * `verify-artifact`), `complete` is H1 afterwards, `tip` is T.
 */
export type LiveGapListingV1 = "gap" | "complete" | "tip";

function rowsOf(listing: LiveGapListingV1): readonly LiveRunV1[] {
  if (listing === "tip") return TIP_RUNS;
  return listing === "gap"
    ? HEAD_RUNS.filter((run) => run.name !== "verify-artifact")
    : HEAD_RUNS;
}

function suiteOf(listing: LiveGapListingV1): number {
  return listing === "tip" ? LIVE_GAP.tipSuite : LIVE_GAP.headSuite;
}

/**
 * The runs as the runtime port reads them, bound to `head` (a rig commit or
 * the live one). `at` re-bases the instants so the listing's first start is
 * `at`, keeping the live offsets (the carried bound counts from them).
 */
export function liveGapChecks(
  listing: LiveGapListingV1,
  head: GitSha,
  at?: number,
): SuitedCheckV1[] {
  const rows = rowsOf(listing);
  const first = Math.min(...rows.map((run) => Date.parse(run.startedAt)));
  const shift = at === undefined ? 0 : at - first;
  return rows.map((run) => ({
    name: run.name,
    status: "completed",
    conclusion: "success",
    head,
    startedAt: Date.parse(run.startedAt) + shift,
    completedAt: Date.parse(run.completedAt) + shift,
    suite: suiteOf(listing),
  }));
}

/** The same runs as the GitHub check-runs endpoint reports them. */
export function liveGapWire(
  listing: LiveGapListingV1,
  head: string = listing === "tip" ? LIVE_GAP.tip : LIVE_GAP.head,
): Record<string, unknown>[] {
  return rowsOf(listing).map((run) => ({
    id: run.id,
    name: run.name,
    head_sha: head,
    status: "completed",
    conclusion: "success",
    started_at: run.startedAt,
    completed_at: run.completedAt,
    check_suite: { id: suiteOf(listing) },
    app: { slug: "github-actions" },
  }));
}

/**
 * A fake check run in suite `suite` (a scheduled or dispatched
 * workflow on the base included).
 */
export function suiteCheck(
  name: string,
  head: GitSha,
  suite: number,
  at: number,
): SuitedCheckV1 {
  return {
    name,
    status: "completed",
    conclusion: "success",
    head,
    startedAt: at,
    completedAt: at + 60_000,
    suite,
  };
}

/**
 * The live sentinel `development` tips' check runs
 * (`tests/fixtures/repair/sentinel-development-check-runs-live.json`): L80
 * 9a1b1d924 (22 runs, 7 of them past the strict 64-character label bound) and
 * the current tip 3f041b46d (75 runs, 33 past it). ci.yml's push run
 * (`test-local`), one suite per five-minute `dispatch` schedule, and the
 * supervisor.yml runs of `sentinel-supervisor`, which is fast-forwarded with
 * `development`; no pull request head runs dispatch or supervisor.yml.
 */
const LIVE_DEVELOPMENT = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../fixtures/repair/sentinel-development-check-runs-live.json",
      import.meta.url,
    ),
  ),
) as { listings: Record<string, Record<string, unknown>[]> };

export const LIVE_L80 = "9a1b1d924dc386ea46a9f7828115883c6e6f7cb3" as GitSha;
export const LIVE_TIP = "3f041b46d95269b29054ca5c27bce6aa179f9683" as GitSha;

/** The live listing of `commit` as the endpoint reports it, bound to `head`. */
export function liveDevelopmentWire(
  commit: GitSha,
  head: string = commit,
): Record<string, unknown>[] {
  const runs = LIVE_DEVELOPMENT.listings[commit];
  if (runs === undefined) throw new Error(`no live listing for ${commit}`);
  return runs.map((run) => ({ ...run, head_sha: head }));
}

/**
 * The REAL GitHub port (`GitHubPortImpl` over scripted HTTP) of `repository`
 * answering every check read of `head` with the live listing of `commit`
 * bound to it, and no commit statuses.
 */
export function liveDevelopmentPort(
  repository: RepositoryIdentityV1,
  head: GitSha,
  commit: GitSha,
) {
  const path = `/repos/${repository.owner}/${repository.name}/commits/${head}`;
  return makePort({
    repository,
    script: [
      {
        ...httpRespond(
          "GET",
          `${path}/check-runs?per_page=100&page=1`,
          200,
          checksPageWire(liveDevelopmentWire(commit, head)),
        ),
        repeat: true,
      },
      {
        ...httpRespond("GET", `${path}/statuses?per_page=100&page=1`, 200, []),
        repeat: true,
      },
    ],
  });
}

/**
 * Route `github`'s check reads (the strict `readChecks` and the coverage
 * `readCheckSuites` alike) of each head in `routes` through its own REAL port
 * over the live listing it names; every other head keeps the fake's answer.
 * Returns each routed head's scripted transport (its recorded requests).
 */
export function routeLiveDevelopment(
  github: GitHubPort,
  repository: RepositoryIdentityV1,
  routes: Readonly<Record<string, GitSha>>,
) {
  const live = new Map(
    Object.entries(routes).map((
      [head, commit],
    ) => [head, liveDevelopmentPort(repository, head as GitSha, commit)]),
  );
  const readChecks = github.readChecks.bind(github);
  const readCheckSuites = github.readCheckSuites.bind(github);
  github.readChecks = (sha, names) =>
    live.get(sha)?.port.readChecks(sha, names) ?? readChecks(sha, names);
  github.readCheckSuites = (sha) =>
    live.get(sha)?.port.readCheckSuites(sha) ?? readCheckSuites(sha);
  return new Map(
    [...live].map(([head, { transport }]) => [head, transport]),
  );
}
