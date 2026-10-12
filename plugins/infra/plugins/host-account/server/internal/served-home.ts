import { serveValue } from "@plugins/network/plugins/live/server";
import { HOME_DIR } from "@plugins/infra/plugins/paths/server";
import { hostHome } from "../../core";

// External: the truth is the process environment (`os.homedir()`, read once
// into HOME_DIR at module load), which nothing observes — and which never
// changes under a running process, so the value is `fixed`. It is the same
// HOME_DIR host-fs expands `~` against, already `resolve()`d at its one
// definition — the spelling host-fs returns every path in — so a path the
// browser shortens to `~/…` with it names what the server reads.
export const hostHomeServed = serveValue(hostHome, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "the home directory a process runs with never changes while it runs",
    },
  },
  loader: (): string => HOME_DIR,
});
