// @ts-check

import * as core from "@actions/core";

import { post } from "./lib/post.js";
import request, { ensureNativeProxySupport } from "./lib/request.js";

async function run() {
  ensureNativeProxySupport();

  return await post(core, request);
}

run().catch(() => {
  core.setFailed("Sentinel App token cleanup failed");
});
