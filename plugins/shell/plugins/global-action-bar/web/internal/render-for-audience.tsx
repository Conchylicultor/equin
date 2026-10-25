import type { ReactNode } from "react";
import {
  ForAudience,
  type AudienceMark,
} from "@plugins/audience/plugins/developer-mark/web";
import type { ActionBarContribution } from "@plugins/shell/plugins/action-bar/web";

/**
 * Renders one action-bar contribution for the audience it declares — the
 * `.Render` child every host of `ActionBar.Item` / `ActionBar.ViewOption` uses,
 * so a developer-only action is absent for a regular user in all of them, and
 * marked for a developer (`ForAudience` draws the mark it gates by).
 */
function renderForAudience(
  item: ActionBarContribution,
  mark: AudienceMark,
): ReactNode {
  return (
    <ForAudience audience={item.audience} mark={mark}>
      <item.component />
    </ForAudience>
  );
}

/** An `ActionBar.Item`: a developer-only button wears the corner badge. */
export function renderItemForAudience(item: ActionBarContribution) {
  return renderForAudience(item, "badge");
}

/** An `ActionBar.ViewOption`: a developer-only row's label ends in the mark. */
export function renderViewOptionForAudience(item: ActionBarContribution) {
  return renderForAudience(item, "label");
}
