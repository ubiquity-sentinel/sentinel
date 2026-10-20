/** Legacy private authorities must still refuse malformed historical state. */
import { driveSupersessionRefusals } from "./owner-install-supersession-refusal-fixtures.ts";

// The owner-install ceremony is retired; hosted-workflow-migration_test.ts covers self-install.
Deno.test(
  "owner supersession exact authority refuses changed identity state source proof floor and native custody",
  driveSupersessionRefusals,
);
