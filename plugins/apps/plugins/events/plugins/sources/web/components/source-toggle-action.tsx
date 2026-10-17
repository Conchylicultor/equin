import type { ReactElement } from "react";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useUpdateEventSource } from "@plugins/apps/plugins/events/plugins/events-core/web";
import type { EventSource } from "@plugins/apps/plugins/events/plugins/events-core/core";

/**
 * Enable / disable a source from the list row.
 *
 * Unconfirmed, unlike its neighbour delete: this destroys nothing and the very
 * same control puts it back, so a dialog would be pure friction in front of a
 * decision the user can reverse by clicking again.
 *
 * A SWITCH, not an icon button. A switch carries its own state — knob left over
 * an empty track, knob right over a filled one — so the control answers "is
 * this source on?" by looking like it. The pause/play glyph it replaces could
 * not: a pause icon is equally readable as "this source IS paused" and as
 * "click to pause", and the reader has to guess which, on a row where the only
 * other clue is a label that changes only once they hover.
 *
 * What "disabled" MEANS is three things, not one:
 *
 * - the scheduler never picks the source up (no cadence tick reaches it);
 * - "Refresh now" refuses it, and a "Refresh all" never even asks;
 * - its events drop out of the events list.
 *
 * That last one is the reason this action is worth a row control. It is a
 * *query-time default* in `event-list`, NOT a delete — every event the source
 * ever collected stays in the table untouched, and re-enabling brings all of
 * them straight back. So this is the one-click "stop caring about this source"
 * switch: the venue that went quiet stops filling the list, and nothing is lost
 * if it starts up again.
 */
export function SourceToggleAction({
  row,
}: ItemActionProps<EventSource>): ReactElement {
  const update = useUpdateEventSource();
  const label = row.enabled ? "Disable source" : "Enable source";

  return (
    <WithTooltip content={label}>
      <Switch
        checked={row.enabled}
        aria-label={label}
        // `onCheckedChange` is handed the next state and no event, so it could
        // not stop propagation even if it wanted to — and it does not need to.
        // The `RowActions` cluster this renders inside already stops click and
        // pointerdown for everything under it, so a toggle here can never also
        // fire the row's own onSelect (which would open the detail pane) or arm
        // a row drag.
        onCheckedChange={(next) => {
          update.mutate({ params: { id: row.id }, body: { enabled: next } });
        }}
      />
    </WithTooltip>
  );
}
