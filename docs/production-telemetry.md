# Local production telemetry

Run `deno task telemetry` to fetch, consolidate, save and print the production scorecard. Run `deno task telemetry:report` for an offline report from saved evidence, with no subprocess or network permission. Every successful invocation saves JSON at `.sentinel/telemetry/latest.json` and an immutable copy in `reports/`. The default archive is relative to the executing workspace; use one persistent archive when working in multiple worktrees.

The first sync collects seven days with at most 120 read-only GitHub GETs and a 240-second collection deadline. Each request has a 30-second bound. After native proof reads, each known-completed attempt also archives its complete native log ZIP, including maintenance, planner, repair and finalize logs. ZIP bytes are retained unchanged without extraction or execution; the separate bound repair log remains the metric parser input. Saved coverage sessions distinguish newly captured, reused, unavailable and budget-deferred complete archives. `gh` uses its existing authentication internally; the tool never reads tokens, authentication headers or configuration. No installation, background process, cron, cloud service, runtime invocation or GitHub mutation is involved.

The scorecard shows full actual runtime SHA, generation-specific production intervals, ordinary healthy/completed counts and native log coverage. Bootstrap, rollback and verification purposes stay separate, including failed installation journals. Actions workflow outcomes are a separate population. A workflow head is retained only as metadata; it never supplies missing runtime identity. Unassigned attempts, expired logs, incomplete pages, read limits and native binding refusals remain visible in JSON.

Production boundaries use immutable installation journals and their application transition clocks, not an invented remote CAS completion time. Open intervals are clipped at the report cutoff. Missing journal continuity keeps exposure unknown; repeated deployments remain separate intervals under the same SHA. The exact recorded current journal prior is shown without selecting or executing rollback.

Observed merged PRs are deduplicated by target/PR/merge SHA and attributed by actual merge time. Observed total merges/hour is separate from proven autonomous merges/hour and is a lower bound when merge-list coverage is incomplete; unknown exposure keeps either rate unknown. Human merge receipts establish owner/manual observations; an App actor alone establishes neither owner intent nor autonomy. Positive fresh autonomous acceptance is unknown without source-bound proof of both a fresh effect and durable acceptance. Existing/carried receipts, touched PRs, loop progress and healthy idle runs never become new delivery. Known merged observations survive partial page refreshes; completeness requires one coherent sync/capture, and disappeared or changed evidence retains uncertainty. Complete merge-list coverage with no unclassified merge can establish zero autonomous merges. Short idle health samples do not rank rollback safety.

## Options and stable archive

Tool-specific options are `--archive PATH`, `--days 1..90`, `--cutoff ISO`, `--max-reads 1..500` and `--deadline-seconds 1..240`. The cached report preserves the most recent sync cutoff, or a captured run-query cutoff on import; pass `--cutoff` to choose a different measurement boundary. Metadata is refreshed each sync; verified immutable blobs and completed job logs are reused. Job listings freeze only when the attempt was already confirmed complete at capture time and the entire listing is present. Fresh current-runtime attempt/job/log reads precede old merge detail enrichment. A bounded journal pass reads at most eight missing snapshot journals: normally the exact predecessor chain, or an exceptional generation-gap search using pointer source hints and remaining snapshot entries to recover a rollback journal. Later syncs reuse fetched blobs and continue missing evidence; no unbounded scan is introduced. A retained bootstrap retry proof preserves the first activation clock.

From a worktree, use an absolute code path and grant exactly the persistent archive path:

```sh
deno run --frozen --allow-read=/Users/nv/repos/ubiquity/sentinel/.sentinel/telemetry --allow-write=/Users/nv/repos/ubiquity/sentinel/.sentinel/telemetry --allow-run=gh /absolute/worktree/ops/telemetry.ts sync --archive /Users/nv/repos/ubiquity/sentinel/.sentinel/telemetry --max-reads 120 --deadline-seconds 240
deno run --frozen --allow-read=/Users/nv/repos/ubiquity/sentinel/.sentinel/telemetry --allow-write=/Users/nv/repos/ubiquity/sentinel/.sentinel/telemetry /absolute/worktree/ops/telemetry.ts report --archive /Users/nv/repos/ubiquity/sentinel/.sentinel/telemetry
```

## Import an existing capture

`import --import-manifest PATH` reads a JSON manifest with `entries: [{source, saved, bytes, sha256}]`. Saved paths must reside below the manifest's directory. The tool verifies the manifest's file hashes, reads original `github-commands.json` receipts and imports only allowlisted `gh api --method GET` outputs. It retains original request/observation time, endpoint, raw content hash, manifest hash and receipt identity. Repeating import is idempotent. An immutable import-disposition session lists every imported or excluded command, its reason, and seed files outside that original GET output set. The seed remains preserved separately. Derived scorecards and arbitrary model artifacts are not accepted as native proof. No `gh` permission is needed for import.

```sh
deno run --frozen --allow-read=/absolute/seed,/absolute/archive --allow-write=/absolute/archive /absolute/worktree/ops/telemetry.ts import --archive /absolute/archive --import-manifest /absolute/seed/IMPORT-MANIFEST.json
```

## Archive and interruption

`blobs/<sha256>` contains unchanged response bytes. `observations/<sha256>.json` contains immutable fetch provenance, including failures. `sessions/` records read-budget/deadline and pagination coverage. `reports/` contains immutable scorecards; `index.json` and `latest.json` are atomic replaceable indexes. A completed observation is recoverable by scanning even if a process stops before index publication. Partial temporary files are ignored. No archive data is automatically deleted or expired. A later 404/410 appends an error observation and cannot erase earlier evidence or a completed native proof. Credential-shaped content is refused, rather than redacted into a false native digest.

An exclusive `lock.json` serializes sync, import and report writes. A second invocation refuses access; it never guesses that a lock is stale or deletes it. After a crash, inspect the recorded PID and task ownership and confirm that process has ended before manually removing only that archive's lock. A subsequent invocation recovers completed observations. Corrupt immutable files cause a refusal and remain available for diagnosis; retain a copy before manual repair. This archive lock controls only this tool's local archive.
