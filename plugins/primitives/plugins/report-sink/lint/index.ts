import noDirectSinkRegister from "./no-direct-sink-register";
import collectThroughCompanion from "./collect-through-companion";
import collectorFromMatches from "./collector-from-matches";
import sinkIdMatchesDeclaration from "./sink-id-matches-declaration";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "report-sink",
  rules: {
    // Outside the browser, a sink's handler is a `sinkHandlers` entry.
    "no-direct-sink-register": noDirectSinkRegister,
    // In the browser, another plugin's sink is collected by a companion.
    "collect-through-companion": collectThroughCompanion,
    "collector-from-matches": collectorFromMatches,
    // A sink's id is `<plugin path>:<binding>`, unique: it keys its handler in the build's table.
    "sink-id-matches-declaration": sinkIdMatchesDeclaration,
  },
  // A test registers a handler to observe what its subject emits.
  outOfScope: {
    "no-direct-sink-register": ["test", "research", "generated"],
    "collect-through-companion": ["test", "research", "generated"],
    // A test's throwaway sinks never reach the build's table.
    "sink-id-matches-declaration": ["test", "research", "generated"],
  },
} satisfies LintContribution;
