import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  DocumentHead,
  matchHeadFragment,
  mergeHeadFragments,
} from "./internal/fragments";
export type { HeadFragments, HeadFragmentSource } from "./internal/fragments";

export default {
  description:
    "What the SPA shell's <head> must carry before the first frame, per app path: the DocumentHead.Fragment contribution a server plugin renders its head HTML through (the theme's CSS), and the merge of every source into one fragment per path.",
  portable: true,
} satisfies ServerPluginDefinition;
