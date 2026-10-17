import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pageActivityServed } from "./internal/arm";

export default {
  description:
    "The page arm of the activity space: binds the live page rows of `page_blocks` into the activity union (title from the page's data, last change of its row); every field exposed on a page folds into its band.",
  register: [pageActivityServed],
} satisfies ServerPluginDefinition;
