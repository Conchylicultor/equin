import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { ReloadLossController } from "./internal/reload-loss-controller";
import { ReloadLossKindView } from "./components/reload-loss-kind-view";

export default {
  description:
    "Reload-loss collector: for a developer (Developer mode on), a Core.Root controller runs kept-state's dev unmount detector (watchStateLoss) and files each piece of React state a remount throws away — a page-level place unmounting with useState / useReducer the user changed that is neither kept nor useTransient — as a deduped reload-loss report, plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: ReloadLossController, scope: "page" }),
    Reports.KindView({ match: "reload-loss", component: ReloadLossKindView }),
  ],
} satisfies PluginDefinition;
