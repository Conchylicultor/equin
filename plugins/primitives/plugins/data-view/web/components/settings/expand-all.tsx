import type { ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { DataViewControlAction } from "../../slots";
import {
  useDataViewControls,
  type DataViewControlsContextValue,
} from "../controls/controls-context";

const unfoldMoreIcon = symbol("unfold-more");
const unfoldLessIcon = symbol("unfold-less");

/**
 * The expand-all toolbar control's action (`DataViewSlots.Control`, action
 * kind): present only while the active view reports an expand-all capability
 * (`ctx.expandAll` — it nests a hierarchy with a row to fold), and flipping
 * every expandable row in one batched write. Its label and glyph follow the
 * state: "Collapse all" once everything is open, else "Expand all".
 */
export function expandAllAction(
  ctx: DataViewControlsContextValue,
): DataViewControlAction | null {
  const { expandAll } = ctx;
  if (!expandAll) return null;
  const collapse = expandAll.allExpanded;
  return {
    label: collapse ? "Collapse all" : "Expand all",
    icon: collapse ? unfoldLessIcon : unfoldMoreIcon,
    run: () => expandAll.setAll(!collapse),
  };
}

/**
 * The view settings' "Rows" section over the same capability: Expand all and
 * Collapse all as two rows — a menu has the room to say both, so neither
 * hides behind the toggle's current state.
 */
export function ExpandAllSetting(): ReactNode {
  const { expandAll } = useDataViewControls();
  if (!expandAll) {
    throw new Error(
      "ExpandAllSetting rendered without an expand-all capability — its " +
        "isApplicable must gate it on ctx.expandAll",
    );
  }
  return (
    <ControlPanel.Section label="Rows">
      <ControlPanel.Row
        icon={<Icon icon={unfoldMoreIcon} />}
        onSelect={() => expandAll.setAll(true)}
      >
        Expand all
      </ControlPanel.Row>
      <ControlPanel.Row
        icon={<Icon icon={unfoldLessIcon} />}
        onSelect={() => expandAll.setAll(false)}
      >
        Collapse all
      </ControlPanel.Row>
    </ControlPanel.Section>
  );
}
