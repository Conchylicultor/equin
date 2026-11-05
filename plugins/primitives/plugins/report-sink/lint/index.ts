import noDirectSinkRegister from "./no-direct-sink-register";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "report-sink",
  rules: {
    // Outside the browser, a sink's handler is a `sinkHandlers` entry.
    "no-direct-sink-register": noDirectSinkRegister,
  },
  // A test registers a handler to observe what its subject emits.
  outOfScope: {
    "no-direct-sink-register": ["test", "research", "generated"],
  },
} satisfies LintContribution;
