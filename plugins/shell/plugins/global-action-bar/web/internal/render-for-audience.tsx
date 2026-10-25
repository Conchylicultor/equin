import type { ReactNode } from "react";
import { ForAudience } from "@plugins/audience/web";
import {
  DeveloperBadge,
  DeveloperMark,
} from "@plugins/audience/plugins/developer-mark/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import type { ActionBarContribution } from "@plugins/shell/plugins/action-bar/web";

/**
 * Renders one action-bar contribution for the audience it declares, and — when
 * that is the developer — with the developer mark: the gate and the mark are
 * one step, so a contribution that declares `audience: "developer"` is marked
 * without drawing anything itself, and one cannot be hidden from users yet
 * shown to developers unmarked.
 *
 * The mark's form is the host's: a bar button wears the badge on its corner
 * ({@link renderItemForAudience}), a gear-popover row the pill after its label
 * ({@link renderViewOptionForAudience}).
 */
function renderForAudience(
  item: ActionBarContribution,
  mark: (node: ReactNode) => ReactNode,
) {
  const node = <item.component />;
  return (
    <ForAudience audience={item.audience}>
      {item.audience === "developer" ? mark(node) : node}
    </ForAudience>
  );
}

/** An `ActionBar.Item`: a developer-only button wears the corner badge. */
export function renderItemForAudience(item: ActionBarContribution) {
  return renderForAudience(item, (node) => (
    <DeveloperBadge>{node}</DeveloperBadge>
  ));
}

/** An `ActionBar.ViewOption`: a developer-only row's label ends in the mark. */
export function renderViewOptionForAudience(item: ActionBarContribution) {
  return renderForAudience(item, (node) => (
    <ControlPanel.LabelMark mark={<DeveloperMark />}>
      {node}
    </ControlPanel.LabelMark>
  ));
}
