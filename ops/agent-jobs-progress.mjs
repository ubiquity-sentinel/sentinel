// Uploads one small text file as a run artifact while the cell is still
// running, so a job's progress can be read through the API before it ends
// (the API serves neither the log nor the annotations of a running job).
// Usage: node agent-jobs-progress.mjs <artifact name> <file>
// Needs ACTIONS_RUNTIME_TOKEN and ACTIONS_RESULTS_URL, which the workflow
// exports for the cell step. That token reaches this run's artifacts only.
import { DefaultArtifactClient } from "@actions/artifact";
import { dirname } from "node:path";

const [name, file] = process.argv.slice(2);
if (!name || !file) {
  console.error("usage: agent-jobs-progress.mjs <artifact name> <file>");
  process.exit(2);
}
await new DefaultArtifactClient().uploadArtifact(name, [file], dirname(file), {
  retentionDays: 1,
});
