import type { GitSha } from "../../src/contracts/brands.ts";
import { parseHostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  LAUNCHER,
  PRIOR_STATE_HEAD,
  STATE_HEAD,
} from "./owner-install-fixture-constants.ts";

export const STARTUP_CANDIDATE =
  "ee5e6518a4333c20d8bc6a4c3c577a2536ec6b9b" as GitSha;
export const STARTUP_FAILED =
  "d77d3169fdd268c955dda24ae2bae7b35c5e2295" as GitSha;
export const STARTUP_PRIOR =
  "e4cef46332cf124a8c283d798a963cf5f66e45c2" as GitSha;
export const STARTUP_RUNTIME = parseHostedRuntimeRecordV1({
  "activeRevision": "d77d3169fdd268c955dda24ae2bae7b35c5e2295",
  "createdAt": 1789358128122,
  "execution": null,
  "generation": 66,
  "id": "Ubiquity-Sentinel/sentinel:0:production",
  "kind": "hosted_runtime",
  "lastExecutionProof": {
    "baseSha": null,
    "execution": {
      "createdAt": 1791498288192,
      "generation": 66,
      "id": "37853282835:1:repair",
      "launcherSha": "bd8fd3121def476864f0da2cc389dbe27243ca7b",
      "purpose": "bootstrap",
      "releaseId": null,
      "revision": "d77d3169fdd268c955dda24ae2bae7b35c5e2295",
      "runAttempt": 1,
      "runId": 37853282835,
    },
    "finishedAt": 1791498365000,
    "jobId": 113571535486,
    "logDigest":
      "5cc3a0f45ac4bfb6eb4593f4aec9b99484b62d5a99445dce5f73c8b729802e58",
    "observedAt": 1791498376748,
    "outcome": "failed",
    "ref": "refs/heads/sentinel-supervisor",
    "repository": "Ubiquity-Sentinel/sentinel",
    "settled": true,
    "startedAt": 1791498316000,
    "startupReady": false,
    "terminalAt": 1791498362441,
    "workflowId": 357012162,
    "workflowPath": ".github/workflows/supervisor.yml",
  },
  "lastHealthyProof": {
    "baseSha": "f79a890d1020be13b5b650968430e80b51fc35e1",
    "execution": {
      "createdAt": 1791417309456,
      "generation": 63,
      "id": "37704666277:1:repair",
      "launcherSha": "44031db6fd9cbc91755a9d4501e1481b9cd09b89",
      "purpose": "ordinary",
      "releaseId": null,
      "revision": "e4cef46332cf124a8c283d798a963cf5f66e45c2",
      "runAttempt": 1,
      "runId": 37704666277,
    },
    "finishedAt": 1791419897000,
    "jobId": 113081997296,
    "logDigest":
      "aad29414cf59ddbc3916fe2566c1749dd2ac12c6e2ab9a1c9bce659f0b1fd90f",
    "observedAt": 1791419943131,
    "outcome": "healthy",
    "ref": "refs/heads/sentinel-supervisor",
    "repository": "Ubiquity-Sentinel/sentinel",
    "settled": true,
    "startedAt": 1791418334000,
    "startupReady": true,
    "terminalAt": 1791419892505,
    "workflowId": 357012162,
    "workflowPath": ".github/workflows/supervisor.yml",
  },
  "nextOrdinaryAt": 1791498288192,
  "updatedAt": 1791498377143,
  "version": "v1",
});
export const STARTUP_NOW = 1791498387143;
export function startupAuthority(head = STATE_HEAD) {
  return {
    releaseHead: head,
    repairHead: PRIOR_STATE_HEAD,
    witnessHead: "bfd8d4304a04696a7692ab21e0a06d05bad41641" as GitSha,
    healthyProof: STARTUP_RUNTIME.lastHealthyProof!,
    nativeQuiescent: true as const,
    nativeProofsVerified: true as const,
    run: { runId: 999999, runAttempt: 1, launcherSha: LAUNCHER },
  };
}
