import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { ScopedOutDispatchCollector } from "./components/scoped-out-dispatch-collector";
import { ScopedOutDispatchKindView } from "./components/scoped-out-dispatch-kind-view";

export default {
  description:
    "Scoped-out-dispatch collector: drains slot-render's scopedOutDispatchSink into a deduped report whenever a dispatch slot renders its fallback inside a PluginScope though the page holds a contribution for that key which the scope's composition neither bundles nor negates (the demo's tool cards falling back to the generic card), plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: ScopedOutDispatchCollector }),
    Reports.KindView({
      match: "scoped-out-dispatch",
      component: ScopedOutDispatchKindView,
    }),
  ],
} satisfies PluginDefinition;
