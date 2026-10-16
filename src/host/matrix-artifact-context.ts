/** Internal authenticated matrix transport operation contracts. */
import type {
  HostedExecutionIntentV1,
  HostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import type { Clock, StateReadView } from "../contracts/ports.ts";
import type {
  createDeadline,
  HttpResponseV1,
  HttpTransportV1,
} from "../github/http.ts";
import type { MatrixArtifactTransportV1 } from "./matrix-artifact-port.ts";
import type { Json } from "./matrix-artifact-values.ts";

export interface MatrixArtifactOptionsV1 {
  state: StateReadView;
  token: string;
  http: HttpTransportV1;
  clock: Clock;
  artifactRoot: string;
}
export type MatrixArtifactRecoveryInputV1 =
  & Parameters<MatrixArtifactTransportV1["recover"]>[0]
  & {
    rejectionProof?: HostedRunProofV1;
    completedExecution?: HostedExecutionIntentV1;
    /** Only an explicit trusted caller permits exact not-started revalidation. */
    revalidateNotStarted?: boolean;
  };
export type MatrixArtifactDeadlineV1 = ReturnType<typeof createDeadline>;
export interface MatrixArtifactReaderV1 {
  json(path: string): Promise<Json>;
  pages(path: string, key: string): Promise<Json[]>;
  download(
    path: string,
    binary: boolean,
    unserved?: () => never,
  ): Promise<HttpResponseV1>;
}
