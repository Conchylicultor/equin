import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { blockedArtifactUrlKind } from "./internal/kind";
import { blockerScanJob } from "./internal/scan-job";

export default {
  description:
    "The daily web-artifacts.blocker-scan job (main only, in a supervised child running `./equin web-artifacts-blocker-scan`) and the blocked-artifact-url report kind it files through the outbox: one row per (source file, rule) whose served URL a default content-blocker rule cancels.",
  contributions: [blockedArtifactUrlKind],
  register: [blockerScanJob],
} satisfies ServerPluginDefinition;
