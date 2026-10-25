import {
  DataViewSlots,
  type DataViewControlAction,
  type DataViewPanelControl,
} from "../../slots";
import { useDataViewControls } from "../controls/controls-context";

/**
 * One applicable control, resolved for the active view: a panel control (its
 * trigger opens its panel) or an action control's current action (its trigger
 * acts). Every place the controls are reached renders both kinds — `kind` is
 * the one branch, so a renderer cannot forget the action kind (tsc).
 */
export type ToolbarControl =
  | { kind: "panel"; id: string; control: DataViewPanelControl }
  | { kind: "action"; id: string; action: DataViewControlAction };

/**
 * The toolbar's control list and badge count, derived ONE way for every place
 * the controls are reached — the band (wide and compact) and a hosted
 * surface's options trigger — so they cannot disagree about which controls
 * apply or what the badge says.
 *
 * Reads `DataViewSlots.Control`, drops the ones that do not apply to the active
 * view + schema (a panel control's `isApplicable`; an action control's
 * `action` answering `null`), and orders them. Both are pure and asked BEFORE
 * anything mounts — a control that does not apply costs nothing, not even a
 * mounted-then-null component.
 *
 * `activeCount` is what the open panels would tell you, added up. Each
 * control's own `summary` answers for itself (`count` defaults to the whole
 * thing it describes), so a new control counts into the badge with no edit
 * here. An action narrows nothing and never counts. It does NOT include the
 * search query — callers that fold search into the same trigger add it.
 */
export function useToolbarControls(): {
  controls: ToolbarControl[];
  activeCount: number;
} {
  const ctx = useDataViewControls();
  const controls: ToolbarControl[] = [];
  let activeCount = 0;
  const sorted = [...DataViewSlots.Control.useContributions()].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  for (const c of sorted) {
    if (c.action) {
      const action = c.action(ctx);
      if (action) controls.push({ kind: "action", id: c.id, action });
      continue;
    }
    if (!(c.isApplicable?.(ctx) ?? true)) continue;
    controls.push({ kind: "panel", id: c.id, control: c });
    const s = c.summary?.(ctx) ?? null;
    if (s) activeCount += s.count ?? 1 + (s.more ?? 0);
  }
  return { controls, activeCount };
}
