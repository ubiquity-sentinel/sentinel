/**
 * Part E of the checker: pull request continuity.
 *
 * Owner rule: once a record has published its pull request, every later
 * publication RESUMES that pull request (a push to its deterministic branch,
 * then a review request on the same PR); review never goes back to opening a
 * new one. The lifecycle (`pipeline.ts`) carries the GitHub-side state of
 * the record's own PR (`none` | `open` | `closed`), and the publication edge
 * is labelled by what the REAL code does from that state:
 *
 * - `advanceToCorrection` (review P0/P1, a CI-red head corrected before or
 *   after review, a red head before a refresh) keeps `target.pr`, and the
 *   publication then requests review on it (`continuePublication`, anchored);
 * - `markTerminalBlocked` clears `target.pr` while the PR stays open on
 *   GitHub, so a re-admitted park publishes through `createPullRequestFor`:
 *   the real `GitHubPort.createPullRequest` reuses the exact own open PR on
 *   the deterministic head branch and sends no create;
 * - `retireClosedPublication` clears `target.pr` once the PR is closed
 *   unmerged and returns the record to work, and the real port then CREATES
 *   a replacement pull request (no open PR on the branch).
 *
 * A publication from `open` that the port would not reuse is a duplicate PR
 * (never allowed). A publication from `closed` is a replacement PR: the only
 * way back from review to opening a pull request.
 */
import {
  httpRespond,
  makePort,
  PR_AUTHOR,
  pullWire,
  refWire,
  SHA1,
  SHA2,
} from "../github/helpers.ts";
import type { PullRequestCreateV1 } from "../../src/contracts/ports.ts";
import { retireClosedPublication } from "../../src/repair/loop-records.ts";
import {
  advanceToCorrection,
  markTerminalBlocked,
} from "../../src/repair/transitions.ts";
import { anchor } from "./anchors.ts";
import type { GraphV1 } from "./explore.ts";
import { key, type PEdgeV1, type PStateV1 } from "./pipeline.ts";
import { concretize, DEFAULT_SHAPE, NOW } from "./world.ts";

export type PrStateV1 = PStateV1["pr"];

/** What the real code decides about the record's pull request. */
export interface PrFactsV1 {
  /** A correction keeps `target.pr` (and the branch and base). */
  correctionKeepsPr: boolean;
  /** A terminal park clears `target.pr` (the PR itself stays open). */
  terminalParkClearsPr: boolean;
  /** A closed-unmerged PR is retired: `target.pr` null, back to work. */
  closedPrRetired: boolean;
  /** The port reuses the exact own open PR on the head branch (no create). */
  portReusesOpenOwnPr: boolean;
  /** The port creates a new PR when the branch's only PR is closed. */
  portCreatesAfterClose: boolean;
}

let facts: PrFactsV1 | null = null;

export const PR_ANCHORS = {
  resumeAfterPush: anchor(
    "e.resumeAfterPush",
    "src/repair/loop-publication.ts",
    `    if (proved.target.pr !== null) {
      return requestReviewFor(deps, context, proved, proved.target.pr);
    }`,
  ),
  continuePublication: anchor(
    "e.continuePublication",
    "src/repair/loop-publication-state.ts",
    `  if (record.target.pr !== null) {
    return requestReviewFor(deps, context, record, record.target.pr);
  }
  return createPullRequestFor(deps, context, record, config);`,
  ),
  portReuse: anchor(
    "e.portReuse",
    "src/github/port-publication.ts",
    "// 2. Discover existing PRs on the exact head ref; reuse only the exact own",
  ),
  deterministicBranch: anchor(
    "e.deterministicBranch",
    "src/repair/loop-publication-state.ts",
    "const branch = candidateBranch(record.id);",
  ),
  refreshOnOwnPr: anchor(
    "e.refreshOnOwnPr",
    "src/repair/loop-base-refresh.ts",
    "pullRequestNumber: record.target.pr,",
  ),
  closedRetired: anchor(
    "e.closedRetired",
    "src/repair/loop-review-observation.ts",
    `clearIntent(retireClosedPublication(record, now, "work"), now),`,
  ),
};

function request(body: string): PullRequestCreateV1 {
  return {
    title: "Sentinel repair: issue 900",
    headRef: "sentinel/fix-1",
    baseRef: "development",
    body,
    expectedBase: SHA2,
    expectedHeadRef: SHA1,
  };
}

/** One real `createPullRequest` with the branch's PRs as GitHub lists them. */
async function publishOver(
  listed: "open" | "closed",
): Promise<{ number: number | null; created: boolean }> {
  const body = "Resolves #900";
  const existing = pullWire({
    number: 21,
    body,
    state: listed,
    head: { ref: "sentinel/fix-1", sha: SHA1 },
    user: { login: PR_AUTHOR },
  });
  const { port, transport } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
      httpRespond("GET", "/pulls?head=", 200, [existing]),
      httpRespond(
        "POST",
        "/repos/ubiquity-sentinel/sentinel/pulls",
        201,
        pullWire({
          number: 22,
          body,
          head: { ref: "sentinel/fix-1", sha: SHA1 },
        }),
      ),
    ],
  });
  const result = await port.createPullRequest(request(body));
  const created = transport.requests.some((sent) => sent.method === "POST");
  return { number: result.ok ? result.value.number : null, created };
}

/** Decide every PR fact with the real code (once per run). */
export async function primePrFacts(): Promise<PrFactsV1> {
  if (facts !== null) return facts;
  const part = await concretize({
    ...DEFAULT_SHAPE,
    nextStep: "review",
    blocker: null,
    wait: null,
    candidate: "published",
    rounds: 1,
    review: "p1",
  });
  const record = part.record;
  if (record.target.pr === null) throw new Error("published shape has no PR");
  const corrected = advanceToCorrection(record, NOW);
  const parked = markTerminalBlocked(record, "other", "park", NOW);
  const retired = retireClosedPublication(record, NOW, "work");
  const reused = await publishOver("open");
  const replaced = await publishOver("closed");
  facts = {
    correctionKeepsPr: corrected.target.pr === record.target.pr &&
      corrected.target.branch === record.target.branch &&
      corrected.nextStep === "work",
    terminalParkClearsPr: parked.target.pr === null,
    closedPrRetired: retired.target.pr === null && retired.nextStep === "work",
    portReusesOpenOwnPr: reused.number === 21 && !reused.created,
    portCreatesAfterClose: replaced.number === 22 && replaced.created,
  };
  return facts;
}

/**
 * What a publication does to the record's PR from one GitHub-side state:
 * nothing new (`undefined`: it resumes the open PR), a first PR, a
 * replacement after a close, or a duplicate next to an open one.
 */
export function publicationOpens(pr: PrStateV1): PEdgeV1["opensPr"] {
  if (facts === null) throw new Error("primePrFacts() first");
  if (pr === "none") return "first";
  if (pr === "closed") {
    return facts.portCreatesAfterClose ? "replacement" : undefined;
  }
  return facts.portReusesOpenOwnPr ? undefined : "duplicate";
}

export interface PrRouteV1 {
  /** The event that leaves review/delivery on the shortest route. */
  leaves: string;
  /** What the publication at the end of the route does. */
  outcome: "resumes_open_pr" | "replacement_pr" | "duplicate_pr";
  /** Shortest route from a reviewed state to that publication. */
  trace: string;
}

export interface PrContinuityV1 {
  facts: PrFactsV1;
  /** Publications that open a second PR while the own PR is open. */
  duplicates: string[];
  /** Every distinct way from review back to a publication, shortest first. */
  routes: PrRouteV1[];
}

/**
 * Publication edges: a candidate published to the record's branch
 * (`preserved_published`, labelled by `publicationOpens`) or a base refresh
 * pushed to it, which needs `target.pr` and updates that same PR.
 */
const PUBLICATIONS: ReadonlySet<string> = new Set([
  "preserved_published",
  "refresh_published",
]);

/** A state after the record's first review request. */
function reviewed(state: PStateV1): boolean {
  return state.phase.startsWith("review.") ||
    state.phase.startsWith("delivery.");
}

function outcomeOf(edge: PEdgeV1): PrRouteV1["outcome"] {
  return edge.opensPr === "replacement"
    ? "replacement_pr"
    : edge.opensPr === "duplicate"
    ? "duplicate_pr"
    : "resumes_open_pr";
}

type StepV1 = { from: string; edge: PEdgeV1 };

/** The routes one exit event opens: BFS to the first publication per path. */
function routesOf(
  graph: GraphV1,
  leaves: string,
  starts: readonly StepV1[],
): PrRouteV1[] {
  const found = new Map<PrRouteV1["outcome"], string>();
  const render = (step: StepV1) =>
    `${step.from} --${step.edge.event}[${step.edge.fair}]-->`;
  const back = new Map<string, StepV1>();
  const queue: string[] = [];
  for (const start of starts) {
    if (PUBLICATIONS.has(start.edge.event)) {
      // The exit is itself a publication (a refresh pushed to the PR).
      const outcome = outcomeOf(start.edge);
      if (!found.has(outcome)) found.set(outcome, render(start));
      continue;
    }
    const target = key(start.edge.to);
    if (back.has(target)) continue;
    back.set(target, start);
    queue.push(target);
  }
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const edge of graph.edges.get(node) ?? []) {
      if (PUBLICATIONS.has(edge.event)) {
        const outcome = outcomeOf(edge);
        if (found.has(outcome)) continue;
        const steps = [render({ from: node, edge })];
        for (let at = node;;) {
          const step = back.get(at)!;
          steps.unshift(render(step));
          if (reviewed(graph.states.get(step.from)!)) break;
          at = step.from;
        }
        found.set(outcome, steps.join(" "));
        continue;
      }
      const target = key(edge.to);
      if (reviewed(edge.to) || back.has(target)) continue;
      back.set(target, { from: node, edge });
      queue.push(target);
    }
  }
  return [...found].map(([outcome, trace]) => ({ leaves, outcome, trace }));
}

/** Every route from a reviewed state back to a publication, by outcome. */
export async function prContinuity(graph: GraphV1): Promise<PrContinuityV1> {
  const decided = await primePrFacts();
  const duplicates: string[] = [];
  // Every way out of review/delivery, grouped by its event.
  const exits = new Map<string, StepV1[]>();
  for (const [from, edges] of graph.edges) {
    for (const edge of edges) {
      if (edge.opensPr === "duplicate") {
        duplicates.push(`${from} --${edge.event}-->`);
      }
      if (!reviewed(graph.states.get(from)!) || reviewed(edge.to)) continue;
      exits.set(edge.event, [...(exits.get(edge.event) ?? []), { from, edge }]);
    }
  }
  const routes = [...exits.keys()].sort().flatMap((leaves) =>
    routesOf(graph, leaves, exits.get(leaves)!)
  );
  return {
    facts: decided,
    duplicates,
    routes: routes.sort((a, b) =>
      `${a.outcome}:${a.leaves}` < `${b.outcome}:${b.leaves}` ? -1 : 1
    ),
  };
}
