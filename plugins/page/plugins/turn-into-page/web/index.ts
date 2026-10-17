import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { TurnIntoPageItem } from "./components/turn-into-page-item";
import { pageInsertAction } from "./internal/page-insert-action";

export default {
  description:
    "Turn a block into a sub-page in place, keeping its id, position, and subtree: from Turn into → Page, or from the caret's line with `/page` (the line's other words become its title, and the new page opens). The page row renders inline as the link.",
  contributions: [
    Editor.TurnInto({ id: "page", component: TurnIntoPageItem }),
    Editor.InsertAction(pageInsertAction),
  ],
} satisfies PluginDefinition;
