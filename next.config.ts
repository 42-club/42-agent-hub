import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { loadSharedAccountEnv } from "./scripts/shared-env.mjs";

loadSharedAccountEnv();

const config: NextConfig = {
  distDir: process.env.HUB_BUILD_DIR || ".next",
  poweredByHeader: false,
  devIndicators: false,
  // The sibling 42-agent dependency is intentionally outside this app root.
  turbopack: { root: process.cwd() },
  outputFileTracingIncludes: { "/*": ["./.runtime/agent-worker.mjs"] },
};
export default withWorkflow(config);
