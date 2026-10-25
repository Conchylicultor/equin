import { ForAudience } from "@plugins/audience/web";
import type { ActionBarContribution } from "@plugins/shell/plugins/action-bar/web";

/**
 * Renders one action-bar contribution for the audience it declares — the
 * `.Render` child every host of `ActionBar.Item` / `ActionBar.ViewOption` uses,
 * so a developer-only action is absent for a regular user in all of them.
 */
export function renderForAudience(item: ActionBarContribution) {
  return (
    <ForAudience audience={item.audience}>
      <item.component />
    </ForAudience>
  );
}
