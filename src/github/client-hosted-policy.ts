// client hosted policy.
import { HOSTED_CONTROLLER_DEPLOYMENT } from "../contracts/hosted-controller-deployment.ts";

/** Development ref compared by the hosted supervisor evidence reads. */
export const ACTIONS_RELEASE_BRANCH = HOSTED_CONTROLLER_DEPLOYMENT.sourceBranch;

/** Bounded signed job-log read for the hosted runtime terminal. */
export const ACTIONS_RELEASE_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** Hosted supervisor execution reader: one bounded whole-operation window. */
export const HOSTED_EXECUTION_READ_DEADLINE_MS = 120_000;

// Native protected workflow: at most 256 matrix cells plus five fixed jobs.
export const HOSTED_EXECUTION_MAX_JOBS = 256 + 5;

export const HOSTED_EXECUTION_JOBS_PAGE_SIZE = 100;

export const HOSTED_EXECUTION_MAX_JOB_STEPS = 100;

export const HOSTED_EXECUTION_BRANCH =
  HOSTED_CONTROLLER_DEPLOYMENT.supervisorBranch;

export const HOSTED_EXECUTION_UNAVAILABLE =
  "hosted execution evidence is unavailable";

export const HOSTED_EXECUTION_SCOPE =
  "hosted execution evidence is restricted to the scope-0 self repository";

export const HOSTED_EXECUTION_REDIRECT =
  "hosted execution log redirect is not trusted";

export const HOSTED_EXECUTION_METADATA = "hosted execution metadata is invalid";
