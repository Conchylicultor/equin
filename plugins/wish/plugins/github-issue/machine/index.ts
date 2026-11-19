import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { RestartSkip } from "@plugins/build/plugins/restart-skip/plugins/hooks/server";
import { issueEnvironmentServed } from "./internal/environment";

export default {
  description:
    "File on GitHub, desktop-only half: serves the github-issue.environment live value — the operating system and Bun the backend runs on, the commit it serves, the newest release in that commit's history, and how many commits it is ahead of and behind the trunk (upstream's main on a clone, main on the canonical repo), re-read when a tracked ref moves or a deploy is adopted.",
  contributions: [
    ...issueEnvironmentServed.declare,
    // A deploy adopted without a restart moves the commit this backend serves.
    RestartSkip.Adopted({
      what: "the commit an issue filed on GitHub names, and where it stands against the trunk",
      adopt: () => issueEnvironmentServed.notify(),
    }),
  ],
} satisfies MachinePluginDefinition;
