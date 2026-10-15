import { Fragment, useMemo, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type {
  ItemActionProps,
  ItemActionsDescriptor,
  ItemActionZone,
} from "../../core";
import { DataViewSlots, collectionItemActionKey } from "../slots";

// The list's own `itemActions`, plus every action its COLLECTION declares
// (`DataViewSlots.CollectionItemAction`) — folded into ONE descriptor, so the
// views (and `useItemActionZones`) see a single set and never know there were
// two. A collection's actions live in the revealed cluster.

const NO_ZONES: Record<ItemActionZone, boolean> = {
  persistent: false,
  revealed: false,
};
const useNoZones = (): Record<ItemActionZone, boolean> => NO_ZONES;

/**
 * `consumer` with the actions registered for `collectionKey` appended — or
 * `consumer` itself when the list has no collection, or the collection
 * declares none. Stable across renders while neither changes.
 */
export function useCollectionItemActions(
  collectionKey: string | undefined,
  consumer: ItemActionsDescriptor<unknown> | undefined,
): ItemActionsDescriptor<unknown> | undefined {
  const all = DataViewSlots.CollectionItemAction.useContributions();
  const owned = useMemo(
    () =>
      collectionKey === undefined
        ? []
        : all.filter((c) => collectionItemActionKey(c.owner) === collectionKey),
    [all, collectionKey],
  );
  return useMemo(() => {
    if (owned.length === 0) return consumer;
    const useConsumerZones = consumer?.useZones ?? useNoZones;
    const ConsumerRow = consumer?.Row;
    const Row = ({
      row,
      hasChildren,
      zone,
    }: ItemActionProps<unknown> & { zone?: ItemActionZone }): ReactNode => (
      <>
        {ConsumerRow && (
          <ConsumerRow row={row} hasChildren={hasChildren} zone={zone} />
        )}
        {zone !== "persistent" &&
          owned.map((c) => (
            <Fragment key={c.id}>
              {renderIsolated(
                DataViewSlots.CollectionItemAction,
                c as unknown as Contribution,
                { row, hasChildren },
              )}
            </Fragment>
          ))}
      </>
    );
    const useZones = (): Record<ItemActionZone, boolean> => {
      const zones = useConsumerZones();
      return { persistent: zones.persistent, revealed: true };
    };
    return { Row, useZones };
  }, [owned, consumer]);
}
