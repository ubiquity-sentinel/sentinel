// Frozen snapshot parser routes nested records through its original exact-key readers.
export { parseHostedRuntimeRecordV1 } from "./hosted-supervisor-runtime.ts";
export { parseHostedReleaseRecordV1 } from "./hosted-supervisor-release.ts";
export type {
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../../../src/contracts/hosted-supervisor.ts";
