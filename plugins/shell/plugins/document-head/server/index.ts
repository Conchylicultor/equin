import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  DocumentHead,
  frameAncestorsByPath,
  matchHeadFragment,
  mergeHeadFragments,
} from "./internal/fragments";
export type {
  FrameAncestorsByPath,
  FrameAncestorsPolicy,
  HeadFragments,
  HeadFragmentSource,
} from "./internal/fragments";

export default {
  description:
    "What the SPA shell must carry before the first frame, per app path: the DocumentHead.Fragment contribution a server plugin renders its head HTML through (the theme's CSS), and the merge of every source into one fragment per path; and DocumentHead.FrameAncestors, the pages that may frame an app's shell (served as its CSP frame-ancestors).",
} satisfies ServerPluginDefinition;
