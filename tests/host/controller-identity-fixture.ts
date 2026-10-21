/** Current native controller facts; historical target receipts stay literal. */
import {
  HOSTED_CONTROLLER_API_PATH,
  HOSTED_CONTROLLER_DEPLOYMENT,
  HOSTED_CONTROLLER_REPOSITORY,
  HOSTED_CONTROLLER_RUNTIME_ID,
  HOSTED_CONTROLLER_SELF,
  HOSTED_CONTROLLER_SUPERVISOR_REF,
  HOSTED_CONTROLLER_WORKFLOW_REF,
} from "../../src/contracts/hosted-controller-deployment.ts";

export const CONTROLLER = Object.freeze({
  repository: HOSTED_CONTROLLER_SELF,
  fullName: HOSTED_CONTROLLER_REPOSITORY,
  apiPath: HOSTED_CONTROLLER_API_PATH,
  runtimeId: HOSTED_CONTROLLER_RUNTIME_ID,
  ref: HOSTED_CONTROLLER_SUPERVISOR_REF,
  workflowRef: HOSTED_CONTROLLER_WORKFLOW_REF,
  workflowId: HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowId,
  workflowPath: HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowPath,
});

/** Only dated public-history scenarios select this branch. */
export const PUBLIC_CONTROLLER = CONTROLLER.repository.owner === "ubiquity" &&
  CONTROLLER.repository.name === "sentinel";
