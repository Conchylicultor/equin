import noRawFdClose from "./no-raw-fd-close";
import noRawSpawnStdioFd from "./no-raw-spawn-stdio-fd";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "owned-fd",
  rules: {
    // A descriptor is closed through its OwnedFd, exactly once.
    "no-raw-fd-close": noRawFdClose,
    // A spawn's stdio descriptor is an OwnedFd's `.fd`.
    "no-raw-spawn-stdio-fd": noRawSpawnStdioFd,
  },
  // Tests run in throwaway processes that hold no pooled sockets; generated
  // files run nothing.
  outOfScope: {
    "no-raw-fd-close": ["test", "research", "generated"],
    "no-raw-spawn-stdio-fd": ["test", "research", "generated"],
  },
} satisfies LintContribution;
