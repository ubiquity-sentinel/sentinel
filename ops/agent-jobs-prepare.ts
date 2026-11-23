import {
  pinAgentJobsPlan,
  readPublicAgentJobRepository,
} from "./agent-jobs-admission.ts";
import {
  agentJobsCleanupMatrix,
  parseAgentJobsCleanup,
} from "./agent-jobs-cleanup.ts";
import {
  parseAgentJobJson,
  readAgentJobsPushRequests,
  requireAgentJobOperator,
} from "./agent-jobs-intake.ts";
import { mergeAgentJobRequests, planAgentJobs } from "./agent-jobs-plan.ts";

async function prepare() {
  const started = Date.now();
  const env = (name: string) => Deno.env.get(name) ?? "";
  const [kind] = Deno.args;
  if (kind !== "inbox" && kind !== "cleanup") {
    throw new Error("unknown agent jobs request lane");
  }
  if (
    env("GITHUB_REPOSITORY") !== "ubiquity-sentinel/sentinel" ||
    env("GITHUB_REF") !== "refs/heads/development"
  ) throw new Error("agent jobs requires the Sentinel development ref");

  const eventName = env("GITHUB_EVENT_NAME");
  const manual = eventName === "workflow_dispatch" && kind === "inbox";
  if (!manual && eventName !== "push") {
    throw new Error("unsupported agent jobs event");
  }
  const event = parseAgentJobJson(
    await Deno.readTextFile(env("GITHUB_EVENT_PATH")),
  );
  requireAgentJobOperator(event, env("GITHUB_ACTOR"));
  const requestCheckout = env("AGENT_JOBS_REQUEST_CHECKOUT");
  if (!manual && !requestCheckout) {
    throw new Error("agent jobs push is missing its request checkout");
  }
  const documents = manual
    ? [parseAgentJobJson(env("AGENT_JOBS_JSON"))]
    : await readAgentJobsPushRequests(
      kind,
      event,
      env("GITHUB_SHA"),
      requestCheckout,
    );
  const output = env("GITHUB_OUTPUT");
  if (documents.length === 0) {
    await Deno.writeTextFile(output, "has-work=false\n", { append: true });
    console.log("No fresh agent job requests");
    return;
  }

  const directory = env("AGENT_JOBS_PREP_DIR");
  let plan: unknown;
  let matrix: unknown;
  if (kind === "inbox") {
    const admitted = await pinAgentJobsPlan(
      planAgentJobs(
        documents.length === 1
          ? documents[0]
          : mergeAgentJobRequests(documents),
        {
          agentsPerCell: env("AGENT_JOBS_PER_CELL") || undefined,
          maxCells: env("AGENT_JOBS_MAX_CELLS") || undefined,
        },
      ),
      started,
    );
    plan = admitted;
    matrix = {
      include: admitted.cells.map((
        { cellId, owner, repositories, runner },
      ) => ({
        cellId,
        owner,
        repositories,
        runner,
      })),
    };
    const jobs = admitted.cells.reduce((n, cell) => n + cell.jobs.length, 0);
    console.log(
      "Planned " + jobs + " agent jobs in " + admitted.cells.length + " cells",
    );
  } else {
    const branches = parseAgentJobsCleanup(documents);
    await Promise.all(
      [...new Set(branches.map((item) => item.repository))].map((repository) =>
        readPublicAgentJobRepository(repository)
      ),
    );
    plan = { branches };
    matrix = agentJobsCleanupMatrix(branches);
    console.log(
      "Planned " + branches.length + " result branch cleanup entries",
    );
  }
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(directory + "/plan.json", JSON.stringify(plan));
  await Deno.writeTextFile(
    output,
    "has-work=true\nmatrix=" + JSON.stringify(matrix) + "\n",
    { append: true },
  );
}

if (import.meta.main) await prepare();
