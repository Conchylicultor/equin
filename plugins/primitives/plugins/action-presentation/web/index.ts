import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  ActionFormProvider,
  ActionFormShield,
  MenuItemForm,
  useActionForm,
  useHoldShrink,
  type ActionForm,
  type ItemFormChannel,
  type ShrinkLadder,
  type YieldEagerness,
} from "./internal/action-form";
export {
  PanelActionRow,
  type PanelActionRowProps,
} from "./components/panel-action-row";

export default {
  description:
    "The shrink-ladder seam between a widget and the bar that hosts it: useActionForm declares the smaller forms a widget can render ITSELF as (and how eagerly it yields room to its neighbours) and reads back the form the region assigned — one hook, both directions. A region can only hand a widget a form that widget declared, so a rich control can never be transformed into something it is not; PanelActionRow renders the 'row' rung, the one IconButton declares — a labelled row that stands alone in the always-mounted overflow panel, never a menu item.",
  contributions: [],
} satisfies PluginDefinition;
