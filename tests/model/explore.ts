/**
 * Graph exploration and the J1/J2 checks over the lifecycle model.
 *
 * `explore` builds the reachable graph from every admissible initial state.
 * `nonTerminating` decides termination by ranking over strongly connected
 * components (Tarjan): inside one component a ranking that some edge spends
 * and no edge replenishes bounds those edges, so they are removed and the
 * rest re-decomposed; a component left with a cycle is a J2 witness.
 */
import type { ParkVerdictV1 } from "./census.ts";
import { PARK_CLASSES } from "./census.ts";
import {
  type Fairness,
  key,
  type ModelOptionsV1,
  type PEdgeV1,
  type Phase,
  type PStateV1,
  type Rank,
  type ReadmissionLinkV1,
  type ReadmissionV1,
  successors,
} from "./pipeline.ts";

export interface GraphV1 {
  states: Map<string, PStateV1>;
  edges: Map<string, PEdgeV1[]>;
  /** BFS parent of each state (shortest path from an initial state). */
  parent: Map<string, { from: string; edge: PEdgeV1 } | null>;
}

export function explore(
  initial: readonly PStateV1[],
  readmit: ReadonlyMap<string, ReadmissionLinkV1>,
  options: ModelOptionsV1 = {},
): GraphV1 {
  const states = new Map<string, PStateV1>();
  const edges = new Map<string, PEdgeV1[]>();
  const parent = new Map<string, { from: string; edge: PEdgeV1 } | null>();
  const queue: PStateV1[] = [];
  for (const state of initial) {
    const id = key(state);
    if (states.has(id)) continue;
    states.set(id, state);
    parent.set(id, null);
    queue.push(state);
  }
  while (queue.length > 0) {
    const state = queue.shift()!;
    const out = successors(state, readmit, options);
    edges.set(key(state), out);
    for (const edge of out) {
      const id = key(edge.to);
      if (states.has(id)) continue;
      states.set(id, edge.to);
      parent.set(id, { from: key(state), edge });
      queue.push(edge.to);
    }
  }
  return { states, edges, parent };
}

/** Tarjan's strongly connected components of a subgraph. */
function tarjan(
  nodes: ReadonlySet<string>,
  out: (node: string) => readonly PEdgeV1[],
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  for (const root of nodes) {
    if (indices.has(root)) continue;
    // Iterative depth-first search.
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
    indices.set(root, index);
    low.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const edges = out(frame.node);
      if (frame.next < edges.length) {
        const target = key(edges[frame.next]!.to);
        frame.next++;
        if (!nodes.has(target)) continue;
        if (!indices.has(target)) {
          indices.set(target, index);
          low.set(target, index);
          index++;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(
            frame.node,
            Math.min(low.get(frame.node)!, indices.get(target)!),
          );
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const up = work[work.length - 1]!.node;
        low.set(up, Math.min(low.get(up)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        result.push(component);
      }
    }
  }
  return result;
}

export interface CycleV1 {
  fairness: "coop" | "adv" | "human";
  /** The states of the residual component. */
  states: string[];
  /** One concrete cycle inside it. */
  cycle: { from: string; edge: PEdgeV1 }[];
  /** Canonical identity: the phases and events of the cycle. */
  id: string;
}

const ALLOWED: Record<CycleV1["fairness"], ReadonlySet<Fairness>> = {
  coop: new Set(["sys", "coop"]),
  adv: new Set(["sys", "coop", "adv"]),
  human: new Set(["sys", "coop", "adv", "human"]),
};

/**
 * Residual components no ranking bounds, under one fairness filter. Base
 * moves and infrastructure unavailability never repeat forever (`base` and
 * `infra` edges are excluded under every filter).
 */
export function nonTerminating(
  graph: GraphV1,
  fairness: CycleV1["fairness"],
): CycleV1[] {
  const allowed = ALLOWED[fairness];
  const found: CycleV1[] = [];
  const decompose = (
    nodes: ReadonlySet<string>,
    keep: (edge: PEdgeV1) => boolean,
  ) => {
    const inside = (node: string) =>
      (graph.edges.get(node) ?? []).filter((edge) =>
        allowed.has(edge.fair) && keep(edge) && nodes.has(key(edge.to))
      );
    for (const component of tarjan(nodes, inside)) {
      const members = new Set(component);
      const internal = component.flatMap((node) =>
        inside(node).filter((edge) => members.has(key(edge.to)))
      );
      if (internal.length === 0) continue;
      const spent = new Set<Rank>();
      const replenished = new Set<Rank>();
      for (const edge of internal) {
        for (const rank of edge.consumes ?? []) spent.add(rank);
        for (const rank of edge.replenishes ?? []) replenished.add(rank);
      }
      const ranks = [...spent].filter((rank) => !replenished.has(rank));
      if (ranks.length > 0) {
        // Edges spending a ranking nothing here replenishes occur finitely
        // often: drop them and decompose the rest.
        decompose(
          members,
          (edge) =>
            keep(edge) &&
            !(edge.consumes ?? []).some((rank) => ranks.includes(rank)),
        );
        continue;
      }
      // No ranking bounds this component. In the cooperative world the
      // environment is strongly fair: a cooperative (or system) way out of
      // the cycle is eventually taken, so only a cycle with none is a jam.
      // The adversarial and owner-driven worlds choose against the record.
      const fairExit = (nodes: ReadonlySet<string>) =>
        fairness === "coop" &&
        [...nodes].some((node) =>
          (graph.edges.get(node) ?? []).some((edge) =>
            (edge.fair === "coop" || edge.fair === "sys") &&
            !nodes.has(key(edge.to))
          )
        );
      // Each unbounded re-arm (a self-loop) is reported as its own
      // mechanism, then every multi-state cycle left once self-loops are
      // removed.
      for (const node of component) {
        if (fairExit(new Set([node]))) continue;
        for (const edge of inside(node)) {
          if (key(edge.to) === node) found.push(selfLoop(node, edge, fairness));
        }
      }
      const proper = (node: string) =>
        inside(node).filter((edge) =>
          key(edge.to) !== node && members.has(key(edge.to))
        );
      for (const sub of tarjan(members, proper)) {
        if (sub.length < 2) continue;
        const subMembers = new Set(sub);
        if (fairExit(subMembers)) continue;
        found.push(
          witness(
            sub,
            subMembers,
            (node) =>
              proper(node).filter((edge) => subMembers.has(key(edge.to))),
            fairness,
          ),
        );
      }
    }
  };
  // Only states this world can reach from the admissible initial states
  // (base moves and infrastructure outages may happen in any world).
  const reached = new Set<string>();
  const queue = [...graph.parent.entries()].filter(([, parent]) =>
    parent === null
  ).map(([id]) => id);
  for (const id of queue) reached.add(id);
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const edge of graph.edges.get(node) ?? []) {
      if (
        !allowed.has(edge.fair) && edge.fair !== "base" &&
        edge.fair !== "infra"
      ) continue;
      const target = key(edge.to);
      if (reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  decompose(reached, () => true);
  return found;
}

function selfLoop(
  node: string,
  edge: PEdgeV1,
  fairness: CycleV1["fairness"],
): CycleV1 {
  return {
    fairness,
    states: [node],
    cycle: [{ from: node, edge }],
    id: `J2:${fairness}:${node.split("|")[0]}:${edge.event}`,
  };
}

function witness(
  component: string[],
  members: ReadonlySet<string>,
  inside: (node: string) => PEdgeV1[],
  fairness: CycleV1["fairness"],
): CycleV1 {
  // Shortest cycle through the lexicographically first member.
  const start = [...component].sort()[0]!;
  const back = new Map<string, { from: string; edge: PEdgeV1 }>();
  const queue = [start];
  const seen = new Set([start]);
  let closing: { from: string; edge: PEdgeV1 } | null = null;
  while (queue.length > 0 && closing === null) {
    const node = queue.shift()!;
    for (const edge of inside(node)) {
      const target = key(edge.to);
      if (!members.has(target)) continue;
      if (target === start) {
        closing = { from: node, edge };
        break;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      back.set(target, { from: node, edge });
      queue.push(target);
    }
  }
  const cycle: { from: string; edge: PEdgeV1 }[] = [];
  if (closing !== null) {
    cycle.unshift(closing);
    let at = closing.from;
    while (at !== start) {
      const step = back.get(at)!;
      cycle.unshift(step);
      at = step.from;
    }
  }
  const phases = [
    ...new Set(cycle.map((step) => step.from.split("|")[0])),
  ].sort();
  const events = [...new Set(cycle.map((step) => step.edge.event))].sort();
  return {
    fairness,
    states: component,
    cycle,
    id: `J2:${fairness}:${phases.join("+")}:${events.join("+")}`,
  };
}

/** Shortest trace from an initial state to `target`. */
export function traceTo(graph: GraphV1, target: string): string[] {
  const steps: string[] = [];
  let at: string | undefined = target;
  while (at !== undefined) {
    const parent = graph.parent.get(at);
    if (parent === null || parent === undefined) {
      steps.unshift(at);
      break;
    }
    steps.unshift(`--${parent.edge.event}[${parent.edge.fair}]-->`, at);
    at = parent.from;
  }
  return steps;
}

/** Shortest trace from one given start state to the first state matching. */
export function shortestTrace(
  graph: GraphV1,
  start: string,
  accept: (state: PStateV1) => boolean,
): string[] | null {
  const back = new Map<string, { from: string; edge: PEdgeV1 } | null>([[
    start,
    null,
  ]]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const state = graph.states.get(node);
    if (state !== undefined && accept(state)) {
      const steps: string[] = [];
      let at: string | undefined = node;
      while (at !== undefined) {
        const step = back.get(at);
        steps.unshift(at);
        if (step === null || step === undefined) break;
        steps.unshift(`--${step.edge.event}[${step.edge.fair}]-->`);
        at = step.from;
      }
      return steps;
    }
    for (const edge of graph.edges.get(node) ?? []) {
      const target = key(edge.to);
      if (back.has(target)) continue;
      back.set(target, { from: node, edge });
      queue.push(target);
    }
  }
  return null;
}

/**
 * Census verdicts turned into the lifecycle's way back from a park, per
 * review-round regime: the class's variants with rounds left (`unspent`) and
 * with every ordinary round spent (`spent`, legacy variants excluded).
 */
export function linkCensus(
  verdicts: readonly ParkVerdictV1[],
): Map<string, ReadmissionLinkV1> {
  const links = new Map<string, ReadmissionLinkV1>();
  for (const park of PARK_CLASSES) {
    const regime = (spent: boolean): ReadmissionV1 | null | undefined => {
      const tags = park.variants.filter((variant) =>
        (variant.rounds ?? 0) >= 3 === spent && variant.legacy !== true
      ).map((variant) => variant.tag);
      if (tags.length === 0) return undefined;
      const rows = verdicts.filter((verdict) =>
        verdict.classId === park.id && verdict.variant === tags[0]
      );
      const moved = rows.filter((verdict) => !verdict.absorbing);
      if (moved.length === 0) return null;
      const to = phaseOf(moved[0]!);
      return to === null ? null : {
        to,
        red: moved.length === rows.length,
        baseMove: moved.some((row) =>
          row.headCi === "red" && row.movedBy?.includes("[tip=moved")
        ),
      };
    };
    const unspent = regime(false);
    const spent = regime(true);
    links.set(park.id, {
      unspent: unspent === undefined ? spent ?? null : unspent,
      spent: spent === undefined ? unspent ?? null : spent,
    });
  }
  return links;
}

const RECOVERY_PHASE: Record<string, Phase> = {
  "runtime:r.recoverBlockedMissingTaskReview": "review.requested",
  "runtime:r.recoverBlockedAlreadySatisfied": "delivery.closure",
  "runtime:r.bridgeLegacyLoss": "work.published",
  "runtime:r.restoreExistingCandidateRefs": "work.noted",
};

function phaseOf(verdict: ParkVerdictV1): Phase | null {
  const recovery = RECOVERY_PHASE[verdict.movedBy ?? ""];
  if (recovery !== undefined) return recovery;
  const destination = verdict.destination;
  if (destination === null) return null;
  if (destination.merged) return "delivery.released";
  switch (destination.nextStep) {
    case "work":
      return destination.head && !destination.fixMarker
        ? "work.published"
        : "work.fresh";
    case "review":
      return "review.requested";
    case "delivery":
      return "delivery.gate";
    case "done":
      return "done";
    case "blocked": {
      const blocker = destination.blocker;
      if (blocker === null) return null;
      const exact = PARK_CLASSES.find((row) => row.message === blocker);
      const prefixed =
        PARK_CLASSES.filter((row) =>
          blocker.startsWith(row.message.split(":")[0]!)
        ).sort((a, b) => b.message.length - a.message.length)[0];
      const park = exact ?? prefixed;
      return park === undefined ? null : `blocked:${park.id}` as Phase;
    }
  }
}
