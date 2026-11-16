import type { ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  renderIsolated,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import {
  DataViewSlots,
  type DataViewControlAction,
  type DataViewControlSummary,
} from "../../slots";
import {
  useDataViewControls,
  type DataViewControlsContextValue,
} from "../controls/controls-context";
import {
  bothLayouts,
  mapLayout,
  slotLayout,
  type SlotLayout,
} from "../../internal/slot-layout";

/**
 * A control with a panel, resolved for the active view — a panel control of
 * `DataViewSlots.Control`, or a `DataViewSlots.Setting` the surface promoted
 * to the toolbar (`DataViewProps.promotedSettings`). Every renderer draws it
 * the one way: a trigger from `icon` / `label` / `summary`, and the panel
 * `render()` mounts (error-boundary-isolated, through its own slot).
 */
export interface ToolbarPanel {
  id: string;
  label: string;
  icon: IconRef;
  /** What it is doing, in words — the trigger's tooltip and accessible name,
   *  the compact fold's row text; `null` at rest. Computed here, once. */
  summary: DataViewControlSummary | null;
  /** Whether an active summary NARROWS what you see — the trigger then turns
   *  `secondary`. `false` for a promoted setting (configuration). */
  narrows: boolean;
  /** Mounts the panel body. */
  render: () => ReactNode;
}

/**
 * One applicable control, resolved for the active view: a panel (its trigger
 * opens its panel) or an action control's current action (its trigger acts).
 * Every place the controls are reached renders both kinds — `kind` is the one
 * branch, so a renderer cannot forget the action kind (tsc).
 */
export type ToolbarControl =
  | { kind: "panel"; id: string; panel: ToolbarPanel }
  | { kind: "action"; id: string; action: DataViewControlAction };

/** The applicable controls in layout order, and the badge's count. */
export interface ToolbarControls {
  controls: ToolbarControl[];
  activeCount: number;
}

type SettingLayout = ReturnType<typeof DataViewSlots.Setting.useContributions>;

/**
 * The toolbar's control list and badge count, derived ONE way for every place
 * the controls are reached — the band (wide and compact) and a hosted
 * surface's options trigger — so they cannot disagree about which controls
 * apply or what the badge says.
 *
 * Reads `DataViewSlots.Control` in its layout order (the slot's reorder
 * config) and drops the ones that do not apply to the active view + schema (a
 * panel control's `isApplicable`; an action control's `action` answering
 * `null`). Both are pure and asked BEFORE
 * anything mounts — a control that does not apply costs nothing, not even a
 * mounted-then-null component.
 *
 * The surface's promoted settings (`promotedSettings`) lead the list, in the
 * surface's order, each a panel holding that one setting — read from
 * `DataViewSlots.Setting`, whose layout must then be known too. A promoted id
 * naming no setting, or a setting declaring no `promote`, throws (a surface
 * asking for a pill that cannot exist); an inapplicable one draws no trigger.
 *
 * `activeCount` is what the open panels would tell you, added up. Each
 * control's own `summary` answers for itself (`count` defaults to the whole
 * thing it describes), so a new control counts into the badge with no edit
 * here. An action narrows nothing and never counts; neither does a promoted
 * setting. It does NOT include the search query — callers that fold search
 * into the same trigger add it.
 */
export function useToolbarControls(): SlotLayout<ToolbarControls> {
  const ctx = useDataViewControls();
  const promoted = ctx.promotedSettings;
  // The controls' layout not known yet: a read, not an empty list — a band
  // that drew no triggers and no badge would claim there is nothing to narrow
  // by, then grow them. The settings' layout matters only when something is
  // promoted.
  const controlLayout = slotLayout(useSlotOrder(DataViewSlots.Control));
  const settingLayout = slotLayout(useSlotOrder(DataViewSlots.Setting));
  const settingsNeeded: SlotLayout<SettingLayout | null> =
    promoted.length === 0 ? { kind: "known", items: null } : settingLayout;
  return mapLayout(
    bothLayouts(controlLayout, settingsNeeded),
    ({ a: contributions, b: settings }) => {
      const controls: ToolbarControl[] =
        settings === null ? [] : promotedControls(ctx, settings);
      let activeCount = 0;
      for (const c of contributions) {
        if (c.action) {
          const action = c.action(ctx);
          if (action) controls.push({ kind: "action", id: c.id, action });
          continue;
        }
        if (!(c.isApplicable?.(ctx) ?? true)) continue;
        const summary = c.summary?.(ctx) ?? null;
        controls.push({
          kind: "panel",
          id: c.id,
          panel: {
            id: c.id,
            label: c.label,
            icon: c.icon,
            summary,
            narrows: true,
            render: () =>
              renderIsolated(
                DataViewSlots.Control,
                c as unknown as Contribution,
                {},
              ),
          },
        });
        if (summary) activeCount += summary.count ?? 1 + (summary.more ?? 0);
      }
      return { controls, activeCount };
    },
  );
}

/** The surface's promoted settings as panels, in its order. */
function promotedControls(
  ctx: DataViewControlsContextValue,
  settings: SettingLayout,
): ToolbarControl[] {
  const controls: ToolbarControl[] = [];
  for (const id of ctx.promotedSettings) {
    const setting = settings.find((s) => s.id === id);
    if (setting === undefined) {
      throw new Error(
        `DataView(${ctx.storageKey}): promotedSettings names "${id}", which no DataViewSlots.Setting contributes (${settings.map((s) => s.id).join(", ")})`,
      );
    }
    const promote = setting.promote;
    if (promote === undefined) {
      throw new Error(
        `DataView(${ctx.storageKey}): the setting "${id}" declares no \`promote\` — it cannot be a toolbar control of its own`,
      );
    }
    if (!(setting.isApplicable?.(ctx) ?? true)) continue;
    const described = promote.describe?.(ctx) ?? null;
    controls.push({
      kind: "panel",
      id: `setting:${id}`,
      panel: {
        id: `setting:${id}`,
        label: promote.label,
        icon: promote.icon,
        // Configuration, not narrowing: never counted into the badge.
        summary: described === null ? null : { label: described, count: 0 },
        narrows: false,
        render: () =>
          renderIsolated(
            DataViewSlots.Setting,
            setting as unknown as Contribution,
            {},
          ),
      },
    });
  }
  return controls;
}
