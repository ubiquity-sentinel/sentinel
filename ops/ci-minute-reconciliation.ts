/** Private, resumable observations on existing native turns; no store or effect authority. */
import {
  CI_MINUTE_MAX_CATALOG_RUNS,
  CI_MINUTE_MAX_RECORDS,
  ciMinuteDigest,
  ciMonth,
} from "../src/contracts/ci-minute-budget.ts";
import type {
  CiMinuteJobProofV1,
  CiMinuteKnownRunV1,
  CiMinuteLedgerV1,
  CiMinuteProgressV1,
  CiMinuteReadCursorV1,
  CiMinuteReconcilerFactoryV1,
  CiMinuteRunCatalogV1,
} from "../src/contracts/ci-minute-budget.ts";
import { readCiMinuteWindow } from "./hosted-autonomy-github-jobs.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : null;
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
function timestamp(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
  ) return null;
  const n = Date.parse(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function metadata(
  value: unknown,
  repositoryId: number,
): CiMinuteKnownRunV1 | null {
  const run = row(value);
  if (
    !run || row(run.repository)?.id !== repositoryId ||
    !Number.isSafeInteger(run.id) || Number(run.id) < 1 || !sha(run.head_sha) ||
    !Number.isSafeInteger(run.run_attempt) || Number(run.run_attempt) < 1 ||
    Number(run.run_attempt) > 100
  ) return null;
  const status =
    ["queued", "in_progress", "waiting", "requested", "pending", "completed"]
        .includes(String(run.status))
      ? run.status as CiMinuteKnownRunV1["status"]
      : "unknown";
  return {
    repositoryId,
    runId: Number(run.id),
    head: run.head_sha,
    createdAt: timestamp(run.created_at),
    updatedAt: timestamp(run.updated_at),
    runAttempt: Number(run.run_attempt),
    checkedAttempt: 0,
    status,
    terminalProofDigest: null,
    refreshRequired: true,
  };
}
function updateMetadata(
  prior: CiMinuteKnownRunV1,
  next: CiMinuteKnownRunV1,
): boolean {
  if (
    prior.head !== next.head || next.runAttempt < prior.runAttempt ||
    (prior.createdAt !== null && next.createdAt !== prior.createdAt) ||
    (prior.updatedAt !== null && next.updatedAt !== null &&
      next.updatedAt < prior.updatedAt)
  ) return false;
  const changed = next.runAttempt !== prior.runAttempt ||
    next.status !== prior.status ||
    next.updatedAt !== prior.updatedAt;
  Object.assign(prior, next, {
    checkedAttempt: prior.checkedAttempt,
    terminalProofDigest: changed ? null : prior.terminalProofDigest,
    refreshRequired: changed || prior.refreshRequired,
  });
  return true;
}
const attemptDigest = (run: CiMinuteKnownRunV1, attempt: number) =>
  ciMinuteDigest({
    repositoryId: run.repositoryId,
    runId: run.runId,
    attempt,
    head: run.head,
  });
// Repeat the completed boundary second; authenticated identities make this
// overlap idempotent without assuming a millisecond-precise created filter.
const discoveryFrom = (watermark: number) =>
  Math.floor(watermark / 1000) * 1000;
function newCursor(queryDigest: string): CiMinuteReadCursorV1 {
  return {
    queryDigest,
    runPage: 1,
    runOffset: 0,
    attempt: 1,
    jobPage: 1,
    jobsSeen: 0,
    runDigest: null,
    pageDigest: null,
  };
}

export const createCiMinuteReconciler: CiMinuteReconcilerFactoryV1 = (
  input,
) => {
  return async (month, deadline, ledger) => {
    const now = input.clock.now(),
      period = ciMonth(now),
      targets = input.policy.targets;
    if (
      period.month !== month || targets.length === 0 || targets.length > 15 ||
      now >= deadline
    ) return null;
    const catalog: CiMinuteRunCatalogV1 = structuredClone(
      ledger.catalog ?? {
        runs: [],
        cursor: 0,
        passThrough: null,
        complete: false,
      },
    );
    const progress: CiMinuteProgressV1 = structuredClone(
      ledger.progress ?? {
        month,
        through: now,
        windowFrom: catalog.passThrough === null
          ? 0
          : discoveryFrom(catalog.passThrough),
        windowThrough: now,
        targetIndex: 0,
        cursor: null,
        jobs: [],
        completedAttempts: [],
        bindingIndex: 0,
        aliases: [],
      },
    );
    if (
      progress.month !== month || progress.through > now ||
      progress.targetIndex > targets.length ||
      (catalog.passThrough !== null && catalog.passThrough > now)
    ) return null;
    // An already completed catalog starts one fresh bounded metadata pass.
    if (!ledger.progress && catalog.complete) {
      catalog.cursor = 0;
      catalog.complete = false;
    }
    if (progress.windowFrom > progress.windowThrough) {
      progress.windowFrom = progress.windowThrough;
      progress.targetIndex = targets.length;
    }
    if (
      catalog.passThrough !== null && catalog.cursor === catalog.runs.length &&
      progress.targetIndex < targets.length && progress.cursor === null &&
      progress.windowFrom >= discoveryFrom(catalog.passThrough) &&
      progress.windowThrough === progress.through && progress.through < now
    ) {
      progress.through = now;
      progress.windowThrough = now;
      progress.targetIndex = 0;
    }
    let runReads = 0, objectReads = 0;
    const request = async (path: string) => {
      if (input.clock.now() >= deadline) return null;
      if (path.includes("/actions/runs?")) {
        if (runReads >= 4) return null;
        runReads++;
      } else {
        if (objectReads >= 8) return null;
        objectReads++;
      }
      return await input.request(path, deadline);
    };
    const keepProof = (proof: CiMinuteJobProofV1) => {
      if (proof.effectDigest !== null) return true;
      if (!proof.neverStarted) {
        return proof.completedAt === null ||
          proof.completedAt >= period.start ||
          proof.estimate?.executionMonth === null;
      }
      const run = catalog.runs.find((r) =>
        r.repositoryId === proof.identity?.repositoryId &&
        r.runId === proof.identity?.runId
      );
      return run?.updatedAt === null || run?.updatedAt === undefined ||
        run.updatedAt >= period.start;
    };
    const partial = () => ({
      month,
      complete: false,
      watermark: ledger.watermark ?? 0,
      observedAt: input.clock.now(),
      jobs: progress.jobs.filter(keepProof),
      progress,
      completedAttempts: progress.completedAttempts,
      catalog,
    });
    catalog.complete = false;
    try {
      // Preserve the existing one-pending-merge binding bound; these reads also
      // consume the same eight-object budget as attempt/job/timing reads.
      let bindingReads = 0;
      while ((progress.bindingIndex ?? 0) < ledger.reservations.length) {
        const index = progress.bindingIndex ?? 0,
          reservation = ledger.reservations[index];
        const effect = reservation.binding?.effect;
        if (
          effect?.kind === "merge" && reservation.state !== "settled" &&
          !(progress.aliases ?? []).some((a) =>
            a.effectDigest === reservation.effectDigest
          )
        ) {
          if (bindingReads++ >= 1 || input.clock.now() >= deadline) {
            return partial();
          }
          if (effect.pr !== null) {
            const prefix = "/repos/" + effect.repository.owner + "/" +
              effect.repository.name;
            const pull = row(await request(prefix + "/pulls/" + effect.pr));
            const merged = pull?.merge_commit_sha;
            if (
              pull?.merged === true && row(pull.head)?.sha === effect.head &&
              sha(merged)
            ) {
              const commit = row(await request(prefix + "/commits/" + merged));
              const parents = commit?.parents;
              let verified = Array.isArray(parents) && parents.length === 2 &&
                row(parents[0])?.sha === effect.base &&
                row(parents[1])?.sha === effect.head;
              if (
                Array.isArray(parents) && parents.length === 1 &&
                row(parents[0])?.sha === effect.base && effect.head !== null
              ) {
                const original = row(
                  await request(prefix + "/commits/" + effect.head),
                );
                const tree = (v: Row | null) => row(row(v?.commit)?.tree)?.sha;
                verified = sha(tree(commit)) && tree(commit) === tree(original);
              }
              if (verified) {
                (progress.aliases ??= []).push({
                  effectDigest: reservation.effectDigest,
                  head: merged,
                });
              }
            }
          }
        }
        progress.bindingIndex = index + 1;
      }
      while (
        progress.targetIndex < targets.length && input.clock.now() < deadline
      ) {
        if (runReads >= 4) return partial();
        const target = targets[progress.targetIndex],
          scope = target.owner + "/" + target.name;
        const queryDigest = ciMinuteDigest({
          domain: "ci-run-discovery-v1",
          repositoryId: target.repositoryId,
          from: progress.windowFrom,
          through: progress.windowThrough,
        });
        if (!progress.cursor || progress.cursor.queryDigest !== queryDigest) {
          progress.cursor = newCursor(queryDigest);
        }
        const cursor = progress.cursor;
        const range = encodeURIComponent(
          new Date(progress.windowFrom).toISOString() + ".." +
            new Date(progress.windowThrough).toISOString(),
        );
        const listing = row(
          await request(
            `/repos/${scope}/actions/runs?created=${range}&per_page=100&page=${cursor.runPage}`,
          ),
        );
        const total = listing?.total_count, rows = listing?.workflow_runs;
        if (
          !Number.isSafeInteger(total) || Number(total) < 0 ||
          !Array.isArray(rows)
        ) return partial();
        // GitHub caps created-filter searches at 1,000 results. A count at
        // that cap cannot establish coverage, even if total_count is capped.
        if (Number(total) >= 1000) {
          const split = Math.floor(
            (progress.windowFrom + progress.windowThrough) / 2000,
          ) * 1000;
          if (split <= progress.windowFrom || split >= progress.windowThrough) {
            return partial();
          }
          progress.windowThrough = split;
          progress.targetIndex = 0;
          progress.cursor = null;
          continue;
        }
        if (
          rows.length !==
            Math.min(
              100,
              Math.max(0, Number(total) - (cursor.runPage - 1) * 100),
            )
        ) return partial();
        const parsed = rows.map((r) => metadata(r, target.repositoryId));
        if (parsed.some((r) => r === null)) return partial();
        if (
          new Set(parsed.map((r) => r!.runId)).size !== parsed.length ||
          parsed.some((r) =>
            r!.createdAt === null ||
            r!.createdAt < progress.windowFrom ||
            r!.createdAt > progress.windowThrough
          )
        ) {
          return partial();
        }
        const pageDigest = ciMinuteDigest({
          total,
          runs: parsed.map((r) => [r!.runId, r!.head, r!.runAttempt]),
        });
        if (
          cursor.pageDigest !== null && cursor.pageDigest !== undefined &&
          cursor.pageDigest !== pageDigest
        ) {
          progress.cursor = null;
          return partial();
        }
        cursor.pageDigest = pageDigest;
        for (; cursor.runOffset < parsed.length; cursor.runOffset++) {
          const discovered = parsed[cursor.runOffset]!;
          const prior = catalog.runs.find((r) =>
            r.repositoryId === discovered.repositoryId &&
            r.runId === discovered.runId
          );
          if (prior) {
            if (!updateMetadata(prior, discovered)) return null;
          } else {
            if (catalog.runs.length >= CI_MINUTE_MAX_CATALOG_RUNS) {
              return partial();
            }
            catalog.runs.push(discovered);
          }
        }
        if (cursor.runPage * 100 < Number(total)) {
          progress.cursor = {
            ...newCursor(queryDigest),
            runPage: cursor.runPage + 1,
          };
          continue;
        }
        const covered = catalog.runs.filter((run) =>
          run.repositoryId === target.repositoryId && run.createdAt !== null &&
          run.createdAt >= progress.windowFrom &&
          run.createdAt <= progress.windowThrough
        ).length;
        if (covered !== total) {
          progress.cursor = null;
          return partial();
        }
        progress.cursor = null;
        progress.targetIndex++;
        if (progress.targetIndex < targets.length) {
          continue;
        }
        if (progress.windowThrough < progress.through) {
          progress.windowFrom = progress.windowThrough;
          progress.windowThrough = progress.through;
          progress.targetIndex = 0;
        } else catalog.passThrough = progress.through;
      }
      if (progress.targetIndex < targets.length) return partial();
      const known = new Set([
        ...(ledger.completedAttempts ?? []),
        ...progress.completedAttempts,
      ]);
      while (
        catalog.cursor < catalog.runs.length && input.clock.now() < deadline
      ) {
        if (objectReads >= 8) return partial();
        const run = catalog.runs[catalog.cursor],
          target = targets.find((t) => t.repositoryId === run.repositoryId);
        if (!target) return null;
        const scope = target.owner + "/" + target.name;
        const raw = row(
          await request(`/repos/${scope}/actions/runs/${run.runId}`),
        );
        const current = metadata(raw, target.repositoryId);
        if (
          !current || current.runId !== run.runId ||
          !updateMetadata(run, current)
        ) return partial();
        for (const proof of ledger.proofs ?? []) {
          if (
            proof.identity?.repositoryId !== run.repositoryId ||
            proof.identity.runId !== run.runId || proof.effectDigest !== null
          ) continue;
          const effectDigest = effectBinding(
            raw!,
            proof.identity.attempt,
            target.repositoryId,
            ledger,
            progress,
          );
          if (
            effectDigest !== null &&
            !mergeProofs(progress.jobs, [{ ...proof, effectDigest }])
          ) return null;
        }
        if (run.status !== "completed") {
          run.refreshRequired = true;
          progress.cursor = null;
          catalog.cursor++;
          continue;
        }
        if (
          run.checkedAttempt === run.runAttempt &&
          run.terminalProofDigest !== null && !run.refreshRequired
        ) {
          progress.cursor = null;
          catalog.cursor++;
          continue;
        }
        const firstAttempt = run.checkedAttempt < run.runAttempt
          ? run.checkedAttempt + 1
          : run.runAttempt;
        const queryDigest = ciMinuteDigest({
          repositoryId: target.repositoryId,
          scope,
          from: progress.windowFrom,
          through: progress.windowThrough,
          runId: run.runId,
        });
        const cursor = progress.cursor ??
          { ...newCursor(queryDigest), attempt: firstAttempt };
        const slice = await readCiMinuteWindow({
          repositoryId: target.repositoryId,
          scope,
          from: progress.windowFrom,
          through: progress.windowThrough,
          cursor,
          run: raw!,
          estimateMinutes: target.ceilingMinutes,
          knownAttempts: known,
          knownProofs: [...(ledger.proofs ?? []), ...progress.jobs],
          request,
          deadline,
          now: () => input.clock.now(),
          effectDigestFor(value, attempt) {
            return effectBinding(
              value,
              attempt,
              target.repositoryId,
              ledger,
              progress,
            );
          },
        });
        const retained = slice.jobs.filter(keepProof);
        if (!mergeProofs(progress.jobs, slice.jobs)) return null;
        if (progress.jobs.length > CI_MINUTE_MAX_RECORDS) return null;
        for (
          let attempt = run.checkedAttempt + 1;
          attempt <= run.runAttempt;
          attempt++
        ) {
          if (
            !slice.completedAttempts.includes(attemptDigest(run, attempt)) &&
            !known.has(attemptDigest(run, attempt))
          ) break;
          run.checkedAttempt = attempt;
        }
        // Historical attempts remain authenticated by their catalog digest rather
        // than consuming the unrelated 4,096 current-period proof/attempt slots.
        if (retained.length > 0) {
          progress.completedAttempts = [
            ...new Set([
              ...progress.completedAttempts,
              ...slice.completedAttempts,
            ]),
          ];
          for (const digest of slice.completedAttempts) known.add(digest);
        }
        if (progress.completedAttempts.length > CI_MINUTE_MAX_RECORDS) {
          return null;
        }
        if (!slice.complete) {
          progress.cursor =
            ["run_page_changed", "run_cursor_changed", "cursor_binding"]
                .includes(
                  slice.reason ?? "",
                )
              ? null
              : slice.cursor;
          return partial();
        }
        run.terminalProofDigest = ciMinuteDigest({
          domain: "ci-catalog-terminal-v1",
          repositoryId: run.repositoryId,
          runId: run.runId,
          head: run.head,
          attempt: run.runAttempt,
          prior: run.terminalProofDigest,
          proofs: progress.jobs.filter((p) =>
            p.identity?.repositoryId === run.repositoryId &&
            p.identity.runId === run.runId
          )
            .map((p) => p.estimate?.terminalProofDigest ?? ciMinuteDigest(p)),
        });
        run.checkedAttempt = run.runAttempt;
        run.refreshRequired = false;
        progress.cursor = null;
        progress.jobs = progress.jobs.filter(keepProof);
        catalog.cursor++;
      }
      if (catalog.cursor < catalog.runs.length) return partial();
      const pending = catalog.runs.findIndex((run) => run.refreshRequired);
      if (pending !== -1) {
        catalog.cursor = pending;
        return partial();
      }
      // Catch up discovery after a multi-turn historical pass without restarting
      // that pass. New rows append after the completed known-run cursor.
      if (catalog.passThrough !== now) {
        progress.through = now;
        progress.windowFrom = discoveryFrom(catalog.passThrough ?? 0);
        progress.windowThrough = now;
        progress.targetIndex = 0;
        progress.cursor = null;
        return partial();
      }
      catalog.complete = true;
      return {
        month,
        complete: true,
        watermark: now,
        observedAt: input.clock.now(),
        jobs: progress.jobs.filter(keepProof),
        progress: null,
        completedAttempts: progress.completedAttempts,
        catalog,
      };
    } catch {
      return partial();
    }
  };
};

function mergeProofs(
  destination: CiMinuteJobProofV1[],
  values: readonly CiMinuteJobProofV1[],
): boolean {
  for (const proof of values) {
    const old = destination.find((p) => p.digest === proof.digest);
    if (!old) destination.push(proof);
    else if (ciMinuteDigest(old) !== ciMinuteDigest(proof)) {
      if (
        old.effectDigest !== null || proof.effectDigest === null ||
        ciMinuteDigest({ ...old, effectDigest: proof.effectDigest }) !==
          ciMinuteDigest(proof)
      ) return false;
      old.effectDigest = proof.effectDigest;
    }
  }
  return true;
}
function effectBinding(
  run: Row,
  attempt: number,
  repositoryId: number,
  ledger: Readonly<CiMinuteLedgerV1>,
  progress: CiMinuteProgressV1,
): string | null {
  if (run.path !== ".github/workflows/ci.yml") return null;
  const matches = ledger.reservations.filter((reservation) => {
    const binding = reservation.binding;
    if (!binding || binding.repositoryId !== repositoryId) return false;
    const effect = binding.effect;
    if (effect.kind === "rerun") {
      return effect.runId === run.id && effect.attempt === attempt &&
        effect.head === run.head_sha;
    }
    // GitHub's creation timestamp identifies a second, not a millisecond instant.
    if (
      attempt !== 1 ||
      Math.floor((timestamp(run.created_at) ?? -1) / 1000) <
        Math.floor(reservation.createdAt / 1000)
    ) return false;
    const expected = progress.aliases?.find((a) =>
      a.effectDigest === reservation.effectDigest
    )?.head ?? effect.head;
    if (
      expected !== run.head_sha ||
      (typeof run.head_branch === "string" &&
        effect.ref !== "refs/heads/" + run.head_branch)
    ) return false;
    return (effect.kind === "merge" || effect.kind === "train_push")
      ? run.event === "push"
      : effect.kind === "train_dispatch"
      ? run.event === "workflow_dispatch"
      : run.event === "pull_request";
  });
  return matches.length === 1 ? matches[0].effectDigest : null;
}
