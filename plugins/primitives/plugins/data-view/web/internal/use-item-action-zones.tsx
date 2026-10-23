import { useMemo, type ReactNode } from "react";
import type {
  ItemActionEntry,
  ItemActionsDescriptor,
  ItemActionTarget,
  ItemActionZone,
} from "../../core";
import { itemActionCanRest } from "./item-action-rest";

/** Renders one arm's actions for one row (`null` arm = nothing can land there). */
export type ItemActionRender<TRow> = (p: ItemActionTarget<TRow>) => ReactNode;

/** One placement's two arms: the actions painted at rest for the row, and the
 *  ones revealed on hover. Each `null` when no contribution can land in it. */
export interface ItemActionArms<TRow> {
  atRest: ItemActionRender<TRow> | null;
  revealed: ItemActionRender<TRow> | null;
}

export interface ItemActionZones<TRow> {
  /** The row's action cluster. */
  cluster: ItemActionArms<TRow>;
  /** The view's primary slot — `null` when the view has none (the primary
   *  action is then in `cluster`, always resting) or nothing is primary. */
  primary: ItemActionArms<TRow> | null;
}

/** No-op entries hook so `useItemActionZones` always calls a hook
 *  unconditionally (rules-of-hooks), whether or not the consumer supplied
 *  `itemActions`. Frozen module constant so it never churns the memo below. */
const NO_ENTRIES: readonly ItemActionEntry[] = [];
const useNoEntries = (): readonly ItemActionEntry[] => NO_ENTRIES;

const CLUSTER_ZONES: readonly ItemActionZone[] = ["persistent", "revealed"];
const CLUSTER_ZONES_WITH_PRIMARY: readonly ItemActionZone[] = [
  "persistent",
  "revealed",
  "primary",
];
const PRIMARY_ZONES: readonly ItemActionZone[] = ["primary"];

const NO_ARMS = { atRest: null, revealed: null } as const;

/**
 * The ONE mapping from an action's declared {@link ItemActionZone} onto a view.
 * It lives here, not in each view child, so the views cannot drift — a view
 * only says which slots it HAS and where each returned arm goes.
 *
 * - **`hasPrimarySlot: false`** ⇒ `primary` is `null` and a `"primary"` action
 *   joins the cluster and always rests (a table keeps Play painted).
 * - **`hasPersistentSlot: false`** ⇒ `cluster.atRest` is `null` and
 *   `cluster.revealed` draws every cluster action, whatever its rest state —
 *   demoted to hover, **never dropped** (the list stays hover-only).
 * - **`hasPersistentSlot: true`** ⇒ each row's actions split by the rest rule
 *   (`itemActionRests`): `atRest` draws those resting for THIS row, `revealed`
 *   the rest. Each arm is `null` when no contribution could ever land in it.
 * - More than one `"primary"` contribution throws: a row has one main verb.
 *
 * Both flags are **required**: a new view type has to answer them.
 *
 * A hook (it reads the live contribution set): call it ONCE per view render —
 * before any early return — and apply the returned render functions per row.
 * The arms are memoized, so a view may put them in a dependency list.
 */
export function useItemActionZones<TRow>(
  itemActions: ItemActionsDescriptor<TRow> | undefined,
  opts: { hasPersistentSlot: boolean; hasPrimarySlot: boolean },
): ItemActionZones<TRow> {
  const { hasPersistentSlot, hasPrimarySlot } = opts;
  const useEntries = itemActions?.useEntries ?? useNoEntries;
  const entries = useEntries();

  const primaries = entries.filter((e) => e.zone === "primary");
  if (primaries.length > 1) {
    throw new Error(
      `data-view: an item-action set may declare at most one \`zone: "primary"\` action, got ${primaries.length}`,
    );
  }
  const demote = !hasPrimarySlot;
  const clusterEntries = demote
    ? entries
    : entries.filter((e) => e.zone !== "primary");
  // Plain booleans as the memo's inputs, so a fresh entries array of the same
  // shape never re-mints the arms.
  const clusterAny = clusterEntries.length > 0;
  const clusterCanRest = clusterEntries.some((e) =>
    itemActionCanRest(e, true, demote),
  );
  const clusterCanReveal = clusterEntries.some((e) =>
    itemActionCanRest(e, false, demote),
  );
  const primary = hasPrimarySlot ? primaries[0] : undefined;
  const hasPrimary = primary !== undefined;
  const primaryCanRest =
    primary !== undefined && itemActionCanRest(primary, true, false);

  return useMemo((): ItemActionZones<TRow> => {
    if (!itemActions) return { cluster: NO_ARMS, primary: null };
    const Row = itemActions.Row;
    const zones = demote ? CLUSTER_ZONES_WITH_PRIMARY : CLUSTER_ZONES;
    const cluster: ItemActionArms<TRow> = !hasPersistentSlot
      ? {
          atRest: null,
          revealed: clusterAny
            ? (p) => <Row {...p} placement="cluster" zones={zones} />
            : null,
        }
      : {
          atRest: clusterCanRest
            ? (p) => (
                <Row
                  {...p}
                  placement="cluster"
                  zones={zones}
                  rest
                  demotePrimary={demote}
                />
              )
            : null,
          revealed: clusterCanReveal
            ? (p) => (
                <Row
                  {...p}
                  placement="cluster"
                  zones={zones}
                  rest={false}
                  demotePrimary={demote}
                />
              )
            : null,
        };
    return {
      cluster,
      primary: hasPrimary
        ? {
            atRest: primaryCanRest
              ? (p) => (
                  <Row {...p} placement="primary" zones={PRIMARY_ZONES} rest />
                )
              : null,
            revealed: (p) => (
              <Row
                {...p}
                placement="primary"
                zones={PRIMARY_ZONES}
                rest={false}
              />
            ),
          }
        : null,
    };
  }, [
    itemActions,
    hasPersistentSlot,
    demote,
    clusterAny,
    clusterCanRest,
    clusterCanReveal,
    hasPrimary,
    primaryCanRest,
  ]);
}
