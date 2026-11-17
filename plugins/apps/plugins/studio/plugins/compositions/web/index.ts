import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Studio } from "@plugins/apps/plugins/studio/plugins/shell/web";
import { compositionsPane, compositionDetailPane, comparePane } from "./panes";
import {
  CompositionItemActions,
  DeleteAction,
} from "./components/composition-item-actions";
import { CompositionDetail } from "./slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { CompositionDetail } from "./slots";
export { compositionsPane, compositionDetailPane, comparePane } from "./panes";
export { compositionNameDraft } from "./internal/composition-name-draft";

export default {
  description:
    "Compositions pane: list named compositions and open a composition's detail pane, whose sections (draft, closure, release) are contributed by sub-plugins.",
  contributions: [
    Pane.Register({ pane: compositionsPane }),
    Pane.Register({ pane: compositionDetailPane }),
    Pane.Register({ pane: comparePane }),
    CompositionItemActions({ id: "delete", component: DeleteAction }),
    Studio.Sidebar({
      id: "compositions",
      title: "Compositions",
      icon: symbol("layers"),
      opens: { pane: compositionsPane, params: {} },
    }),
  ],
  slots: {
    ...CompositionDetail,
    itemActions: CompositionItemActions,
    compositions: compositionsPane,
    "composition-detail": compositionDetailPane,
    "composition-compare": comparePane,
  },
} satisfies PluginDefinition;
