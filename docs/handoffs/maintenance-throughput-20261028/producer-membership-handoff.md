# Positive producer plan membership candidate

Status: ARTIFACT ONLY, FROZEN, UNVALIDATED. This is a concrete seven-file source candidate, not accepted, canonical, reviewed, published, installed or live work. The required evidence recorder and canonical Git-lane creation remain inaccessible. No tests, type checks, lint, formatting commands, size gates, Git metadata operations, network effects, model/review calls or hosted actions were run for this candidate. No children or background jobs exist. Own-turn actual model and effort remain unknown.

The assigned /tmp/sentinel-maintenance-perf-20261028/history-candidate snapshot resolves to /private/tmp/sentinel-maintenance-perf-20261028/history-candidate on this Mac. It is the parent-provided plain archive of exact e6ac2213e27f124db21d13b757a9271066c434c9, compared with /tmp/sentinel-maintenance-perf-20261028/base-source. No Git lane was created. All packaging and handback metadata stays in history-diagnosis, outside the source snapshot.

## Artifacts

- Completed patch: producer-membership-unvalidated.patch, SHA256 279b94e4d6824bdaaacbb0845af076d41761d9e82355940d850e029d39cf31bc.
- Exact base/candidate file hashes and read-only line/byte inventory: producer-membership-manifest.json.
- Prepared recorder registration/run JSON, never executed: producer-membership-prepared-evidence.json. The recorder is /Users/nv/.codex/agents/assets/test-evidence/evidence.ts; every proposed child command has the existing gtimeout 300-second bound and unchanged Deno permissions. Run only after the parent restores the required supported access and integrates the candidate into its recorded Git lane.
- Earlier read-only root-cause report: HANDBACK.md. Its bootstrap timing and source observations are existing evidence, not validation of this new candidate.

## Exact changed paths and SHA256

| Path | Candidate SHA256 | Lines |
| --- | --- | ---: |
| src/contracts/maintenance-index.ts | 72f729ab25a86e47465cb691be66f0b0f4a9365028bedd0acfc19f0c7f1bb11f | 218 |
| ops/hosted-autonomy-current-scan.ts | ad8587b6ffb58438adeb6e8c0d4327aaceb12f8ed05f71b5bef6ce47f6052ead | 346 |
| ops/hosted-autonomy-current-recovery.ts | eba17ad2e446897cbd0192d45c0a9ae3e8c6c2a26a85f96e435b5d1f36fb2327 | 486 |
| ops/hosted-autonomy-producer-recovery.ts | cd0f0a118081acb1459f906c0a979ebcbc19a1d2c945c818a57718240f6164d8 | 788 |
| ops/hosted-autonomy-producer-requests.ts | 368f48b8dd2f3ef5676354693e26d9901fd482ec5d318df817d34f1dc7712b77 | 184 |
| tests/state/maintenance-index_test.ts | 8d056f1ac02e913b4741587df77936b7b12604b14bf5d68cfa18a84e034ba353 | 127 |
| tests/host/hosted-autonomy-producer-membership_test.ts | 5c0fa907d1a7f851ebbd7678dec15857479b5bc548a9397a1ea5ebf8b2fc09c1 | 734 |

Only the final test is new. No shared fixture changed, including hosted-autonomy-rig.ts. No original repository source, ledger, ownership record, credential, environment, CLI option or workflow changed.

## Implemented contract

The existing producer location can carry one optional positive plan descriptor: planDigest, plannerJobId and the complete reservationIds array. Its location already binds full execution identity and proofFingerprint; the scan still freshly reads and fingerprints that exact source before using a descriptor. The optional key keeps old sidecars readable by the new reader. Old readers reject the additional key and retain their existing full-history fallback without overwriting the sidecar.

The producer pass constructs the descriptor from the complete authenticated wave plan already returned by the original transport. No matrix transport was rewritten. It returns metadata only at the existing no-intersection boundary after release/repair custody checks, or after the full selected consumer/readback succeeds with a result for every selected cell. Missing, expired, unlisted, unavailable, refused or partial recovery yields no new descriptor. A descriptor never records that a result is absent, settled or consumed. A previously learned positive plan remains eligible whenever its exact reservation later appears.

The walk skips a full producer pass only if every current pending reservation ID is disjoint from a complete descriptor attached to the freshly verified exact source. Matching and unknown plans use the original recovery consumer. Dedicated/covered/excluded ordering, newer-producer deferral, original deadlines and the parked-producer path remain intact. Disjointness cannot authorize a state write, settlement, refund or admission.

The scan stages newly learned descriptors until the original parent/sequence proof admits that producer into verified discovery ranges. Existing locations can acquire metadata directly. A contradictory descriptor disables plan acceleration and saving for that invocation; it cannot turn a freshly verified consumer result into failure or overwrite the unknown sidecar. Existing strict canonical parsing, nonforce CAS creation/update, conflict/lost-response handling and unknown/corrupt preservation stay unchanged.

No membership is truncated, sampled, deduplicated to fit a bound or evicted. The descriptor reuses the existing MAX_MATRIX_CELLS native-plan bound of 256 and validates every reservation ID and uniqueness. A complete set that fails schema/provenance bounds remains unknown; storage failure leaves no durable new membership, so a later invocation performs ordinary recovery. No sidecar blob/count bound was raised, and no retention/count policy was added. The existing sidecar currently has no separate explicit byte ceiling in its Git transport/parser; its original discovery arrays remain unchanged. This is a limitation of existing storage, not a new exemption. The rejection test includes an oversized complete set to guard against silently retaining a prefix.

## Written regression and benchmark code

The primary new test uses real temporary release/repair/index Git stores, the production current-matrix recovery/scan/index and actual authenticated Actions artifact transport. Fake HTTP serves native attempts, jobs, markers, ZIP archives and signed storage redirects; injected request cost consumes the original five-minute budget without sleeping. The first invocation cannot reach the old matching producer. Fresh dependency/index objects on restart must avoid HTTP work for learned unrelated producers and reach it. The behavior assertion precedes metadata instrumentation assertions, so the expected baseline failure is the repeated restart budget, not merely a missing plan field.

The same case preserves an absent old result and its charged intent, then exposes and consumes its valid late result through the real ingest/accounting path. It additionally restores an exact pending intent for a plan learned while unrelated, proves that its positive membership still admits an absent then late result, and appends a new settled producer/reservation that must be discovered and consumed. It uses authenticated failed-result settlement, avoiding model calls or candidate publication in the benchmark.

Other new cases cover old sidecar read/recovery, corrupt descriptor fallback without replacing the unknown ref or charges, contradictory cached plan digest with a successful freshly verified consumer and preserved ref, and fresh source fingerprint/release-custody refusal. Existing index CAS/lost-response, history reserve/late-artifact, producer deadline and named real candidate-recovery lifecycle checks are prepared as the affected boundaries.

## Manual consistency and remaining gaps

This candidate was manually traced against the production consumers and existing contracts. Manual inspection corrected the test artifact-root/checkout isolation, response Headers type, required shared cooldown gate and result wire fields. These are authored corrections, not executed proof. The existing 788-line producer file remains above the 500-line target and below the 1000-line physical ceiling; its cohesive change is the positive descriptor only. The new test group is 734 lines. These counts are read-only metadata, not a passed size gate.

No parser/type/lint/format/regression/benchmark command has run. The fake HTTP fixtures, injected timing, expected state transitions and before/after performance assertions therefore remain unproved. The new benchmark injects the native settlement read as a strict external port while the real artifact transport authenticates native attempt/job/marker HTTP; the existing named real candidate-recovery lifecycle is the separate prepared integration boundary. No HTTP latency, runner savings or live maintenance gain is claimed.

Disjoint skips inherit the existing trusted sidecar boundary, just as cached nonproducer discovery ranges do; they freshly prove the source identity but intentionally do not reread its artifact. Complete metadata is only produced from authenticated transport output. This trust boundary needs the parent's independent acceptance review before shipping. No cache descriptor can replace native review, CI, candidate proof, custody, charge binding or actual result settlement.

The prepared baseline red command adds only the new regression to exact baseline source and uses --no-check solely because the original additive sidecar type lacks the new optional instrumentation field. It must fail at the semantic second-invocation budget assertion. Every candidate command retains native typechecking, followed by explicit changed-file deno check. The baseline red run, candidate green run and all stated gates remain pending; a setup/type/dependency failure must not be relabeled as the intended regression.

The immediate owner action is to restore the supported canonical Git/evidence-recorder access, apply this exact frozen patch to the recorded lane, then execute and inspect the prepared bounded recorder commands before any publication or installation. Do not use CI, raw shell validation or another storage path to bypass the current restrictions.
