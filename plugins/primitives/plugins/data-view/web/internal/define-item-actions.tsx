import { useMemo, type ComponentType, type ReactNode } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import {
  defineRenderSlot,
  type RenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import type {
  ItemActionEntry,
  ItemActionFilter,
  ItemActionProps,
  ItemActionsDescriptor,
  ItemActionZone,
} from "../../core";
import { itemActionPasses } from "./item-action-rest";

export interface ItemActionContribution<TRow> {
  id: string;
  component: ComponentType<ItemActionProps<TRow>>;
  order?: number;
  /**
   * Where this action belongs — see {@link ItemActionZone}. Default
   * `"revealed"` (the hover cluster). `"persistent"` rests where the view has an
   * at-rest region; `"primary"` is the row's one main verb (at most one per
   * set). The mapping onto a view lives in `useItemActionZones`.
   */
  zone?: ItemActionZone;
  /**
   * Whether this action is "on" for a row (pinned, done, playing). An active
   * action rests (stays painted without hover) in every zone; a `persistent`
   * action that declares it rests ONLY while active. Called once per drawn
   * action per row, so keep it cheap (a store/selector read).
   */
  useActive?: Hook<(row: TRow) => boolean>;
}

export interface ItemActions<TRow>
  extends
    RenderSlot<ItemActionContribution<TRow>>,
    ItemActionsDescriptor<TRow> {}

/** No `useActive` declared: the action's rest state does not depend on the row. */
const useNoActive = (_row: unknown): boolean | undefined => undefined;

/**
 * One contributed action for one row, with the rest filter applied. A
 * component of its own so `useActive` is an ordinary hook call at a stable
 * position (one cell = one contribution), never a hook inside a loop.
 */
function ItemActionCell<TRow>({
  item,
  props,
  filter,
}: {
  item: ItemActionContribution<TRow>;
  props: ItemActionProps<TRow>;
  filter: ItemActionFilter;
}): ReactNode {
  const useActive: Hook<(row: TRow) => boolean | undefined> =
    item.useActive ?? useNoActive;
  const active = useActive(props.row);
  if (!itemActionPasses(item.zone ?? "revealed", active, filter)) return null;
  const C = item.component;
  return (
    <C
      row={props.row}
      hasChildren={props.hasChildren}
      placement={props.placement}
    />
  );
}

/**
 * Mint a per-consumer item-action slot. The returned value is **callable for
 * contributions** (`PageActions({ id, component })`, like any `defineRenderSlot`
 * result) and carries `.Row`, the `ItemActionsDescriptor` views consume. Each
 * consumer calls this once with a stable id; contributors register an action
 * once; every `<DataView>` view renders all contributions in its own trailing
 * affordance.
 */
export function defineItemActions<TRow>(): ItemActions<TRow> {
  const slot = defineRenderSlot<ItemActionContribution<TRow>>({
    docLabel: (p) => p.id,
  });
  const Row = ({
    row,
    hasChildren,
    placement,
    zones,
    rest,
    demotePrimary,
  }: ItemActionProps<TRow> & ItemActionFilter): ReactNode => (
    <slot.Render>
      {(item) => {
        // Filtering happens INSIDE the existing render callback (rather than over
        // a pre-filtered contribution list) so the slot keeps owning ordering and
        // per-item isolation. The zone filter is static; the rest filter needs
        // the row's `useActive`, so the cell applies it.
        if (zones !== undefined && !zones.includes(item.zone ?? "revealed"))
          return null;
        return (
          <ItemActionCell
            item={item}
            props={{ row, hasChildren, placement }}
            filter={{ rest, demotePrimary }}
          />
        );
      }}
    </slot.Render>
  );
  const useEntries = (): readonly ItemActionEntry[] => {
    const items = slot.useContributions();
    return useMemo(
      () =>
        items.map((item) => ({
          zone: item.zone ?? "revealed",
          hasActive: item.useActive !== undefined,
        })),
      [items],
    );
  };
  // `slot` is a callable function-object (like every defineRenderSlot result);
  // attach `Row`/`useEntries` the same way `.Render`/`.useContributions` are attached.
  return Object.assign(slot, { Row, useEntries }) as ItemActions<TRow>;
}
