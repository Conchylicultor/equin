import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { testFailingKind } from "./internal/kind";

export default {
  description:
    "The test-failing report kind: one row per test file of main that went from passing to failing (fingerprint = file path), filed by main's idle test runner once a second run on the same code confirmed the failure. Category error, so the Error reports supervisor stream carries it; its task names the failing cases and the commit range where they started failing.",
  contributions: [testFailingKind],
} satisfies ServerPluginDefinition;
