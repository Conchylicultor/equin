import { Fragment, useMemo, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type {
  ItemActionEntry,
  ItemActionFilter,
  ItemActionProps,
  ItemActionsDescriptor,
} from "../../core";
import { DataViewSlots, collectionItemActionKey } from "../slots";
import { itemActionPasses } from "./item-action-rest";

// The list's own `itemActions`, plus every action its COLLECTION declares
// (`DataViewSlots.CollectionItemAction`) — folded into ONE descriptor, so the
// views (and `useItemActionZones`) see a single set and never know there were
// two. A collection's actions live in the revealed cluster (no `useActive`).

const NO_ENTRIES: readonly ItemActionEntry[] = [];
const useNoEntries = (): readonly ItemActionEntry[] => NO_ENTRIES;
const COLLECTION_ENTRY: ItemActionEntry = {
  zone: "revealed",
  hasActive: false,
};

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
    const useConsumerEntries = consumer?.useEntries ?? useNoEntries;
    const ConsumerRow = consumer?.Row;
    const Row = (
      props: ItemActionProps<unknown> & ItemActionFilter,
    ): ReactNode => {
      const { row, hasChildren, placement, zones } = props;
      const drawsOwned =
        (zones === undefined || zones.includes("revealed")) &&
        itemActionPasses("revealed", undefined, props);
      return (
        <>
          {ConsumerRow && <ConsumerRow {...props} />}
          {drawsOwned &&
            owned.map((c) => (
              <Fragment key={c.id}>
                {renderIsolated(
                  DataViewSlots.CollectionItemAction,
                  c as unknown as Contribution,
                  { row, hasChildren, placement },
                )}
              </Fragment>
            ))}
        </>
      );
    };
    const useEntries = (): readonly ItemActionEntry[] => {
      const entries = useConsumerEntries();
      return useMemo(
        () => [...entries, ...owned.map(() => COLLECTION_ENTRY)],
        [entries],
      );
    };
    return { Row, useEntries };
  }, [owned, consumer]);
}
