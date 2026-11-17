import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { TEST_FAILING_KIND } from "../core";
import { TestFailingSummary } from "./components/test-failing-summary";

export default {
  description:
    "Test-failing report kind's Debug → Reports summary view: one line naming the test file that started failing on main, and the commits it last passed and first failed at.",
  contributions: [
    Reports.KindView({
      match: TEST_FAILING_KIND,
      component: TestFailingSummary,
    }),
  ],
} satisfies PluginDefinition;
