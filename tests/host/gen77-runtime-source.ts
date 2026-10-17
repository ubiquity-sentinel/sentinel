/**
 * Generation-77 runtime modules for rollback tests. A failed generation 78
 * restores the installed generation-77 runtime (R77) once, and R77's own code
 * then consumes whatever generation 78 left behind: matrix cells it planned
 * but never ingested and every repair-state shape it wrote. This helper
 * extracts the exact `src/` and `tests/` trees of the pinned generation-77
 * commit read-only from the local object store (`git archive`) into a
 * disposable directory under the repository root and imports the requested
 * modules from it, so R77's own fixtures and rigs run R77's own code. No
 * network, no checkout mutation. A checkout without the pinned commit reports
 * `gen77Available() === false` so callers mark the case ignored. The same
 * helpers exist for the installed generation-78 runtime (R78), the rollback
 * target of generation 79: `gen78Available` and `loadGen78Modules`, and for
 * the installed generation-79 runtime (R79): `gen79Available` and
 * `loadGen79Modules`, for the live generation-79 launcher (L79, whose `ops/`
 * tree is extracted too): `l79Available` and `loadL79Modules`, and for the
 * installed generation-80 runtime (R80), the rollback target of generation
 * 81: `gen80Available` and `loadGen80Modules` (its `ops/` tree is extracted
 * too, since R80 is also the launcher L80 runs on).
