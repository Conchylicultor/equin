import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  refreshCheckoutIndex,
  refreshIndexIfRacy,
  type IndexTrust,
} from "./internal/refresh";

export default {
  description:
    "Keep a checkout's index able to vouch for its files: refreshCheckoutIndex (git status on a private copy of the index — stat data refreshed, untracked cache filled — published by private-index's compare-and-swap) and refreshIndexIfRacy (the same, only when the index holds racily-clean entries: countRacyEntries, core, reads the index file — entries whose mtime is not older in whole seconds than the index, which every git status / git diff <rev> otherwise re-hashes on every read, since no read of ours may write the index).",
} satisfies ServerPluginDefinition;
