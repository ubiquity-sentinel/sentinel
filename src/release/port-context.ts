// Shared immutable dependencies for the Deno release adapter components.
import type { Clock } from "../contracts/ports.ts";
import type { ReleaseTargetConfigV1 } from "./config.ts";
import type { DenoAuthProviderV1, DenoHttpTransportV1 } from "./http.ts";

export interface DenoReleasePortOptions {
  /** Injected native-fetch-compatible transport (production: `fetch`). */
  transport: DenoHttpTransportV1;
  /** Constructor-injected Deno REST credential source. */
  auth: DenoAuthProviderV1;
  /** Trusted m05 target configuration. */
  config: ReleaseTargetConfigV1;
  /** Clock for sample timestamps. */
  clock: Clock;
}

export class ReleasePortContext {
  protected readonly transport: DenoHttpTransportV1;
  protected readonly auth: DenoAuthProviderV1;
  protected readonly config: ReleaseTargetConfigV1;
  protected readonly clock: Clock;

  constructor(options: DenoReleasePortOptions) {
    this.transport = options.transport;
    this.auth = options.auth;
    this.config = options.config;
    this.clock = options.clock;
  }
}
