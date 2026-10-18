/**
 * Required CI coverage (sentinel issue #154): which checks a head is expected
 * to report before its CI may read green.
 *
 * The CI gates judge the check runs that exist, and GitHub creates a check run
 * only when its job starts: a job with `needs:` (ai.ubq.fi's
 * `verify-artifact`, which needs `validate`, `mac-containment` and
 * `darwin-native`) has none until its dependencies finish, so a head read in
 * that window showed three of three runs green while the required fourth did
 * not exist yet (live: H1 f0008beb62 on PR 1064, five seconds). The base the
 * head is tested against ran the same workflow, so its check names are the
 * expected ones; but a base also carries checks no pull request head ever
 * runs (sentinel `development` holds a `dispatch` run from every five-minute
 * schedule, each in its own suite), so only the base's check suites that share
 * a check name with the head count: every name of such a suite must be on the
 * head. A base check without a suite (a commit status) is never expected.
 *
 * Pure and shared: the runtime's CI-first review gate and carried delivery
 * steps (`GitHubCheckV1`) and the launcher's foreign green read (raw check
 * runs) apply this one rule.
 */

/** One observed check: its name and, for a check run, its suite id. */
export interface CoverageCheckV1 {
  readonly name: string;
  readonly suite?: number | null;
}

/**
 * The expected check names `head` does not report, sorted: every name of each
 * suite of `base` that shares at least one check name with `head`, minus the
 * names `head` reports (in any state; the caller judges their conclusions).
 * Empty when the head reports every expected check, or when no base suite
 * shares a name with it.
 */
export function missingExpectedChecks(
  head: readonly CoverageCheckV1[],
  base: readonly CoverageCheckV1[],
): string[] {
  const reported = new Set(head.map((check) => check.name));
  const suites = new Map<number, Set<string>>();
  for (const check of base) {
    if (check.suite === undefined || check.suite === null) continue;
    const names = suites.get(check.suite) ?? new Set<string>();
    names.add(check.name);
    suites.set(check.suite, names);
  }
  const missing = new Set<string>();
  for (const names of suites.values()) {
    if (![...names].some((name) => reported.has(name))) continue;
    for (const name of names) if (!reported.has(name)) missing.add(name);
  }
  return [...missing].sort();
}
