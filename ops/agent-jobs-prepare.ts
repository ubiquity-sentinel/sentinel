import {
  agentJobsUseStagedBaseV1,
  HOSTED_CONTROLLER_PROFILE,
} from "../src/contracts/hosted-controller-deployment.ts";
import {
  pinAgentJobsPlan,
  readPrivateAgentJobRepository,
  readPublicAgentJobRepository,
  requirePrivateAgentJobHost,
} from "./agent-jobs-admission.ts";
import { privateAgentJobAppAuthorizer } from "./agent-jobs-app-access.ts";
import { stagePrivateAgentJobBase } from "./agent-jobs-base-stage.ts";
import {
  type AgentJobsCleanupEntryV1,
  agentJobsCleanupMatrix,
  parseAgentJobsCleanup,
} from "./agent-jobs-cleanup.ts";
import {
  parseAgentJobJson,
  readAgentJobDispatchRequest,
  readAgentJobsPushRequests,
  requireAgentJobOperator,
  requireAgentJobOperatorWrite,
} from "./agent-jobs-intake.ts";
import { requireInstalledAgentJobsLauncher } from "./agent-jobs-launcher.ts";
import {
  readPrivateActionsMinutes,
  requirePrivateAgentJobsMinutes,
} from "./agent-jobs-minutes.ts";
import { mergeAgentJobRequests, planAgentJobs } from "./agent-jobs-plan.ts";

async function prepare() {
  const started = Date.now();
  const env = (name: string) => Deno.env.get(name) ?? "";
  const [kind] = Deno.args;
  if (kind !== "inbox" && kind !== "cleanup") {
    throw new Error("unknown agent jobs request lane");
  }
  const profile = HOSTED_CONTROLLER_PROFILE;
  const ref = "refs/heads/" + profile.deployment.sourceBranch;
  const workflow = kind === "inbox" ? "agent-jobs" : "agent-jobs-cleanup";
  const workflowRef = profile.repository + "/.github/workflows/" + workflow +
    ".yml@" + ref;
  if (
    !profile.agentJobs || env("GITHUB_REPOSITORY") !== profile.repository ||
    env("GITHUB_REF") !== ref || env("GITHUB_WORKFLOW_REF") !== workflowRef
  ) {
    throw new Error(
      "agent jobs requires the deployment's development workflow",
    );
  }

  const eventName = env("GITHUB_EVENT_NAME");
  const manual = eventName === "workflow_dispatch" && kind === "inbox";
  if (!manual && eventName !== "push") {
    throw new Error("unsupported agent jobs event");
  }
  const event = parseAgentJobJson(
    await Deno.readTextFile(env("GITHUB_EVENT_PATH")),
  );
  const actor = env("GITHUB_ACTOR");
  requireAgentJobOperator(event, actor);
  const nativeToken = env("AGENT_JOBS_NATIVE_TOKEN");
  const useStagedBase = agentJobsUseStagedBaseV1(profile);
  if (useStagedBase) await requirePrivateAgentJobHost(profile, nativeToken);
  await requireAgentJobOperatorWrite(profile.repository, actor, nativeToken);
  if (profile.requireInstalledLauncher) {
    await requireInstalledAgentJobsLauncher(
      env("AGENT_JOBS_CONTROL_SHA"),
      nativeToken,
    );
  }
  const requestCheckout = env("AGENT_JOBS_REQUEST_CHECKOUT");
  if (!manual && !requestCheckout) {
    throw new Error("agent jobs push is missing its request checkout");
  }
  const dispatch = manual ? readAgentJobDispatchRequest(event) : null;
  const documents = dispatch
    ? [dispatch.document]
    : await readAgentJobsPushRequests(
      kind,
      event,
      env("GITHUB_SHA"),
      requestCheckout,
    ).catch(() => {
      throw new Error("agent jobs push request could not be read");
    });
  const output = env("GITHUB_OUTPUT");
  if (documents.length === 0) {
    await Deno.writeTextFile(output, "has-work=false\n", { append: true });
    console.log("No fresh agent job requests");
    return;
  }

  const directory = env("AGENT_JOBS_PREP_DIR");
  const authorizePrivateRepository = useStagedBase
    ? await privateAgentJobAppAuthorizer(env("AGENT_JOBS_APP_PRIVATE_KEY"))
    : undefined;
  let plan: unknown;
  let matrix: unknown;
  if (kind === "inbox") {
    const packed = planAgentJobs(
      documents.length === 1 ? documents[0] : mergeAgentJobRequests(documents),
      {
        agentsPerCell: dispatch?.agentsPerCell || env("AGENT_JOBS_PER_CELL") ||
          undefined,
        maxCells: dispatch?.maxCells || env("AGENT_JOBS_MAX_CELLS") ||
          undefined,
        profile,
      },
    );
    const admitted = await pinAgentJobsPlan(packed, started, {
      profile,
      authorizePrivateRepository,
      checkPrivateMinutes: () =>
        requirePrivateAgentJobsMinutes(
          packed,
          env("AGENT_JOBS_PRIVATE_PAID_OVERAGE"),
          () =>
            readPrivateActionsMinutes(
              profile.repository,
              nativeToken,
              started,
              env("RUNNER_TEMP") + "/agent-jobs-gh",
            ),
        ),
      stagePrivateBase: async (base) => {
        await Deno.mkdir(directory, { recursive: true });
        await stagePrivateAgentJobBase(directory, base);
      },
    });
    plan = admitted;
    matrix = {
      include: admitted.cells.map(
        ({ cellId, owner, repositories, runner, jobs }) => ({
          cellId,
          owner,
          repositories,
          runner,
          pullRequests: jobs.some(({ pr }) => pr),
        }),
      ),
    };
    const jobs = admitted.cells.reduce((n, cell) => n + cell.jobs.length, 0);
    console.log(
      "Planned " + jobs + " agent jobs in " + admitted.cells.length + " cells",
    );
  } else {
    let branches: AgentJobsCleanupEntryV1[];
    try {
      branches = parseAgentJobsCleanup(documents);
    } catch {
      throw new Error("invalid agent jobs cleanup request");
    }
    await Promise.all(
      [...new Set(branches.map((item) => item.repository))].map((repository) =>
        authorizePrivateRepository
          ? readPrivateAgentJobRepository(
            profile,
            repository,
            true,
            authorizePrivateRepository,
          )
          : readPublicAgentJobRepository(repository)
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
