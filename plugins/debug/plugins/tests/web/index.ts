import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { testFilePane, testsPane } from "./panes";
import {
  investigateFailedRuns,
  investigateFailingFiles,
} from "./internal/investigate";

export default {
  description:
    "Debug → Tests: every test file of this checkout with its last known status — harvested from the `./equin test` runs agents already do, matched to the current code by digest — as summary cards (the status filter) over a plugin tree coloured by worst status, and a detail pane per file (last run, failing cases, why flaky, recent runs, Run now, Investigate).",
  contributions: [
    Pane.Register({ pane: testsPane }),
    investigateFailingFiles,
    investigateFailedRuns,
    Pane.Register({ pane: testFilePane }),
    DebugApp.Sidebar({
      id: "tests",
      title: "Tests",
      icon: symbol("science"),
      opens: { pane: testsPane, params: {} },
    }),
  ],
  slots: {
    tests: testsPane,
    testFile: testFilePane,
  },
} satisfies PluginDefinition;
