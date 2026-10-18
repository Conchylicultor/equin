/**
 * The DataView data origin is a UNION, so a stand-in cannot be spelled — on
 * `DataViewProps`, and through the `DataViewSwitcher` path's
 * `DataViewSourceBundle` (a plain `Omit` would have merged the arms back into
 * one object type). Checked by tsc (`./singularity check type-check`): each
 * `Rejects<…>` must compute `true`, so a spelling that became legal is a type
 * error here. Written as type-level assignability, not object literals, so no
 * formatting can move an expect-error off its line.
 *
 * Run: `./singularity test plugins/primitives/plugins/data-view`.
 */

import { describe, expect, test } from "bun:test";
import type {
  LiveAllCollection,
  LiveCollection,
  LiveLookupCollection,
} from "@plugins/network/plugins/live/core";
import type {
  DataViewId,
  DataViewPaging,
  DataViewProps,
  FieldDef,
  HierarchyConfig,
  LiveDataSource,
  ManualOrderConfig,
} from "../../core";
import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import type { DataViewSourceBundle } from "./body-types";

interface Thread {
  id: string;
  subject: string;
}
interface Other {
  key: number;
}

/** `true` when `A` is NOT assignable to `B`. */
type Rejects<A, B> = [A] extends [B] ? false : true;
/** `true` when `A` IS assignable to `B`. */
type Accepts<A, B> = [A] extends [B] ? true : false;

type Base = { fields: FieldDef<Thread>[]; storageKey: DataViewId };
/** A live origin's base: its fields are its collection's. */
type LiveBase = Omit<Base, "fields">;
type Source = LiveDataSource<Thread>;
type RowKey = (row: Thread, index: number) => string;
type Props = DataViewProps<Thread>;
type Bundle = DataViewSourceBundle<Thread>;

// Each origin, alone, is accepted.
const inMemory: Accepts<Base & { rows: Thread[]; rowKey: RowKey }, Props> =
  true;
const live: Accepts<LiveBase & { source: Source }, Props> = true;
const liveBundle: Accepts<{ source: Source }, Bundle> = true;
// A live source derives its fields from its collection: hand `fields` beside
// one has no spelling.
const fieldsBesideSource: Rejects<Base & { source: Source }, Props> = true;

// Stand-ins beside a live origin.
const rowsBesideSource: Rejects<
  LiveBase & { source: Source; rows: Thread[] },
  Props
> = true;
const readinessBesideSource: Rejects<
  LiveBase & { source: Source; readiness: ResourceReadiness },
  Props
> = true;
const twoOrigins: Rejects<
  LiveBase & { source: Source; rows: Thread[]; rowKey: RowKey },
  Props
> = true;

// What a live source refuses: its row key is its collection's id, a tree over
// a paged set orphans children, a rank would reorder server-sorted segments,
// and search is the source's `searchable`.
const rowKeyOnLive: Rejects<
  LiveBase & { source: Source; rowKey: RowKey },
  Props
> = true;
const hierarchyOnLive: Rejects<
  LiveBase & { source: Source; hierarchy: HierarchyConfig<Thread> },
  Props
> = true;
const manualOrderOnLive: Rejects<
  LiveBase & { source: Source; manualOrder: ManualOrderConfig<Thread> },
  Props
> = true;
const searchAccessorOnLive: Rejects<
  LiveBase & { source: Source; searchAccessor: (row: Thread) => string },
  Props
> = true;

// The same, through the DataViewSwitcher bundle (distributive, not a merged Omit).
const bundleSourceRows: Rejects<
  Omit<Base, "storageKey"> & { source: Source; rows: Thread[] },
  Bundle
> = true;
const bundleSourceRowKey: Rejects<
  Omit<Base, "storageKey"> & { source: Source; rowKey: RowKey },
  Bundle
> = true;

// An in-memory origin is a tree or a paged prefix, never both: a tree over a
// partial paged set orphans the children whose parents are not loaded yet.
// Each alone (or an `undefined` hierarchy beside paging) is accepted; so is
// `manualOrder` beside `paging` (the Queue uses both).
type Held = Base & { rows: Thread[]; rowKey: RowKey };
type Paging = DataViewPaging<Thread>;
type Hierarchy = HierarchyConfig<Thread>;
const hierarchyAlone: Accepts<Held & { hierarchy: Hierarchy }, Props> = true;
const pagingAlone: Accepts<Held & { paging: Paging }, Props> = true;
const maybeHierarchy: Accepts<
  Held & { hierarchy: Hierarchy | undefined },
  Props
> = true;
const manualOrderPaged: Accepts<
  Held & { paging: Paging; manualOrder: ManualOrderConfig<Thread> },
  Props
> = true;
const hierarchyBesidePaging: Rejects<
  Held & { hierarchy: Hierarchy; paging: Paging },
  Props
> = true;
const bundleHierarchyBesidePaging: Rejects<
  Omit<Held, "storageKey"> & { hierarchy: Hierarchy; paging: Paging },
  Bundle
> = true;

// A source's rows are its collection's: a DataView over another row type
// cannot take it.
const otherRows: Rejects<Source, LiveDataSource<Other>> = true;

// `liveDataSource` takes a collection's window — every window pages; a
// collection with none (lookup-only, or the whole `all` set) cannot be one.
type Windowed = LiveCollection<Thread, { subject: never }, "subject">;
const lookupIsNoWindow: Rejects<LiveLookupCollection<Thread>, Windowed> = true;
const allIsNoWindow: Rejects<LiveAllCollection<Thread>, Windowed> = true;

describe("DataView data origin (type-level)", () => {
  test("every stand-in is rejected, every lone origin accepted", () => {
    // The assertions are the type annotations above; this keeps them used.
    expect(
      [
        inMemory,
        live,
        liveBundle,
        fieldsBesideSource,
        rowsBesideSource,
        readinessBesideSource,
        twoOrigins,
        rowKeyOnLive,
        hierarchyOnLive,
        manualOrderOnLive,
        searchAccessorOnLive,
        bundleSourceRows,
        bundleSourceRowKey,
        otherRows,
        hierarchyAlone,
        pagingAlone,
        maybeHierarchy,
        manualOrderPaged,
        hierarchyBesidePaging,
        bundleHierarchyBesidePaging,
        lookupIsNoWindow,
        allIsNoWindow,
      ].every(Boolean),
    ).toBe(true);
  });
});
