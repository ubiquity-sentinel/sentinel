import assert from "node:assert/strict";
import { HOSTED_CONTROLLER_PROFILES } from "../../src/contracts/hosted-controller-deployment.ts";
import { requirePrivateAgentJobsMinutes } from "../../ops/agent-jobs-minutes.ts";
import { planAgentJobs } from "../../ops/agent-jobs-plan.ts";

const [, privateProfile] = HOSTED_CONTROLLER_PROFILES;
const privateRepo = "owner/secret";
const request = (repository: string, job: Record<string, unknown> = {}) => ({
  id: repository.split("/")[1],
  repository,
  prompt: "Check fixture",
  minutes: 2,
  ...job,
});

Deno.test("private on-demand minutes use the weighted deadlines and default off", async () => {
  const plan = planAgentJobs([
    request(privateRepo, { minutes: 5 }),
    request(privateRepo, { id: "other", minutes: 10 }),
    request(privateRepo, { id: "mac", minutes: 3, runner: "macos-arm64" }),
  ], { profile: privateProfile, maxCells: 2 });
  // Two Linux jobs overlap on one runner; a three-minute macOS cell costs 30.
  await requirePrivateAgentJobsMinutes(plan, "", () => Promise.resolve(1960));
  await assert.rejects(
    requirePrivateAgentJobsMinutes(plan, "off", () => Promise.resolve(1961)),
    /used=1961 included=2000 remaining=39 requested=40/,
  );
  const unavailable = () => Promise.reject(new Error("private output"));
  await assert.rejects(
    requirePrivateAgentJobsMinutes(plan, "off", unavailable),
    /monthly Actions minutes are unavailable/,
  );
  await requirePrivateAgentJobsMinutes(plan, "on", unavailable);
  await assert.rejects(
    requirePrivateAgentJobsMinutes(plan, "true", unavailable),
    /paid Actions overage setting is unavailable/,
  );
});
