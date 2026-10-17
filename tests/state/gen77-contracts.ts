/**
 * Generation-77 rollback parsers and runtime modules. A failed generation-78
 * first trial restores the installed generation-77 runtime (R77, ab3613e02)
 * once, and that runtime's STRICT contract parsers and repair loop then read
 * and execute every record generation 78 wrote. This helper extracts the exact
 * `src/` tree of the pinned commit read-only from the local object store
 * (`git archive`) into a disposable directory under the repository root and
 * imports the requested modules from it, so a test can prove that every
 * snapshot or matrix plan written by new code parses (or is refused) under the
 * runtime a rollback would reinstate, and run R77's own loop over it. No
 * network, no checkout mutation.
 *
 * The same proof runs against the installed generation-78 runtime (R78,
 * 474f87eb6), the rollback target of generation 79 (`gen78Available`,
 * `loadGen78Modules`, `loadGen78Parsers`, `assertGen78Parses`), and against
 * the installed generation-79 runtime (R79, 549c7a691), the rollback target
 * of generation 80 (`gen79Available`, `loadGen79Parsers`,
 * `assertGen79Parses`), and against the installed generation-80 runtime
 * (R80, e48e7e110), the rollback target of generation 81 (`gen80Available`,
 * `loadGen80Modules`, `loadGen80Parsers`, `assertGen80Parses`).
