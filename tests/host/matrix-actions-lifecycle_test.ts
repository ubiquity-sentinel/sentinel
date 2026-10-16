/** Connected fresh-intake, overlap, native carrier, progressive and historical artifact lifecycles. */
import { freshMatrixArtifacts } from "./matrix-actions-artifact-lifecycle.ts";

Deno.test("matrix actions: actual fresh intake plans both targets, isolated cells overlap, archive recovery publishes on a fresh aggregate", () =>
  freshMatrixArtifacts());
Deno.test("matrix actions: native carrier scopes real in-progress artifact recovery before import", () =>
  freshMatrixArtifacts(false, true));
Deno.test("matrix actions: advancing planner clock admits seventeen cells that each complete in their own bounded window", () =>
  freshMatrixArtifacts(true));
Deno.test("matrix actions: progressive consumer ingests a fast cell while a slower sibling is still active", () =>
  freshMatrixArtifacts(false, false, "settle"));
Deno.test("matrix actions: a live producer without an artifact stays charged, never failed or unhealthy", () =>
  freshMatrixArtifacts(false, false, "missing"));
Deno.test("matrix actions: the maxWaitMs-zero single scan consumer performs exactly one authenticated recovery", () =>
  freshMatrixArtifacts(false, false, "single"));
Deno.test("matrix actions: a consumer window shorter than one scan budget never rescans after consuming a cell", () =>
  freshMatrixArtifacts(false, false, "short"));
Deno.test("matrix actions: authenticated historical runtime mismatch isolates one wave and advances unrelated work", () =>
  freshMatrixArtifacts(false, false, "none", true));
