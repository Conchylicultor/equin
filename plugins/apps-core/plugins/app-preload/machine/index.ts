import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { RestartSkip } from "@plugins/build/plugins/restart-skip/plugins/hooks/server";
import { DocumentHead } from "@plugins/shell/plugins/document-head/server";
import {
  notifyDistAdopted,
  renderAppPreloads,
  subscribeAppPreloads,
} from "./internal/head";

export default {
  description:
    "Starts the active app's code downloading at t0: a DocumentHead.Fragment that puts, per app base path, a <link rel=modulepreload> for every module of that app's deferred plugins — read from the served dist's .app-preloads.json, which web-artifacts' compose writes — so the boot's priority batch is in the HTTP cache by the time it is imported, instead of being fetched after the eager tier. Desktop-only: the head is published by document-head's machine half, from the dist the gateway serves. In every served composition through the served-baseline row.",
  contributions: [
    DocumentHead.Fragment({
      id: "app-preload",
      render: renderAppPreloads,
      subscribe: subscribeAppPreloads,
    }),
    RestartSkip.Adopted({
      what: "the per-app module preloads of the served dist",
      adopt: notifyDistAdopted,
    }),
  ],
} satisfies MachinePluginDefinition;
