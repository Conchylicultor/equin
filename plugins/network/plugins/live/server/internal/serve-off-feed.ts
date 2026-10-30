import { defineExternalResource } from "@plugins/framework/plugins/server-core/core";
import type {
  ExternalKeyedPolicy,
  ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import type { PointParams } from "@plugins/primitives/plugins/live-state/core";
import type { FilterScalar } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  compileOffFeedQuery,
  offFeedReach,
  offFeedTablesReach,
  type CompiledOffFeedQuery,
} from "@plugins/infra/plugins/query-resource/server";
import type {
  LiveCollection,
  LiveCollectionChanges,
  LiveCountParams,
  LiveGroup,
  LiveGroupParams,
  LiveLookupCollection,
  LiveWindowParams,
} from "@plugins/network/plugins/live/core";
import {
  externalCollectionRegistrar,
  type AnyServedExternal,
  type ChangeHooks,
  type ExternalCollectionChangeOptions,
} from "../../core";
import type {
  CollectionSpecs,
  LookupCollectionSpecs,
} from "./serve-collection";

// The SQL arm of `serveCollection` OFF the change feed — the collection's
// source decides only its freshness, never its shape
// (research/2026-10-22-global-live-bounds-independent-of-freshness.md, B6). A
// table outside the feed (one its owner `ExcludeFromChangeFeed`s) still pages
// through the same compiled SQL — the filter language, `$key` cuts, joins,
// `:groups`, `:count` — and `useLive` reads it unchanged:
//
//   serveCollection(archive, { from: _archive, changes: "notified",
//     whileSubscribed: (notify) => onArchiveWrite(() => notify()) });
//
// The specs are `compileCollection`'s, exactly as the routed arm compiles them;
// only the registration differs. The window and `:rows` take query-resource's
// loaders without the scope policy (`compileOffFeedQuery`) and register as the
// runtime's EXTERNAL keyed window / point set: an external keyed loader always
// runs with no `ctx` — a full re-read of the tuple diffed by key, which is the
// windowed FULL read — so its change is the collection's own `notify`, its
// keyed deltas and seeded page derivation (`familyOf`) unchanged. `:groups` /
// `:count` keep their loaders and register as non-keyed externals. Every table
// the SQL reads is declared `unfed` on its reach plan (the keyed policies'
// `offFeedTablesReach`, the non-keyed ones' `offFeedReach`): the drift guard accepts the reads, and change-feed's
// boot check refuses a table the feed covers — so the from table must be
// opted out, and a table served routed must not be (A1′), each by the boot
// assertions both ways. The notify / `whileSubscribed` / `throttleMs` plumbing
// is the external arm's (`externalCollectionRegistrar`).

/**
 * How a collection served off the feed changes — the external arm's
 * `changes` (`"notified"`, or `{ immutable | fixed: { reason } }`) and, on
 * `"notified"` only, its `whileSubscribed` / `throttleMs` (tsc).
 */
export type OffFeedOptions<C extends LiveCollectionChanges> = {
  /**
   * Served OFF the change feed: the rows' table is one its owner opted out
   * (`ExcludeFromChangeFeed`), and a write reaches the readers as `notify`
   * (`"notified"`) — or never, with a reason. Absent: routed through the feed.
   */
  changes: C;
} & ChangeHooks<C>;

/** The collections the SQL arm serves off the feed: a window or a lookup-only one. */
type OffFeedCollection<Row> =
  LiveCollection<Row, unknown, string> | LiveLookupCollection<Row>;

/** Why every table the off-feed SQL reads may go unannounced by the feed. */
function unfedReason(changes: LiveCollectionChanges): string {
  if (changes === "notified") {
    return "served off the change feed — a write reaches its readers as the collection's notify";
  }
  const [arm] = Object.values(changes) as { reason: string }[];
  return `served off the change feed, never told of a change: ${arm!.reason}`;
}

/**
 * Register a collection's compiled specs off the change feed (see the header).
 * Every refusal of the off-feed arm (an `all` set, a `columnScope`) is the
 * caller's, before it compiles; a union never compiles.
 */
export function serveOffFeed<Row>(
  collection: OffFeedCollection<Row>,
  specs: CollectionSpecs | LookupCollectionSpecs,
  opts: ExternalCollectionChangeOptions,
): AnyServedExternal {
  const where = `serveCollection("${collection.key}")`;
  const reg = externalCollectionRegistrar(where, opts);
  // `externalCollectionRegistrar` checked `changes` (a snapshot refused).
  const reason = unfedReason(opts.changes!);
  const keyedPolicy = <P extends ResourceParams>(
    compiled: CompiledOffFeedQuery<Row, P>,
  ): ExternalKeyedPolicy<P> =>
    ({
      membership: compiled.membership,
      reach: offFeedTablesReach<P>(compiled.reads, reason),
    }) as ExternalKeyedPolicy<P>;

  // ── :rows (every form) ──
  const point = collection.rows.point;
  const rowsCompiled = compileOffFeedQuery<Row, PointParams>(
    collection.rows,
    specs.rows,
  );
  const rows = reg.register(
    (common) =>
      defineExternalResource(collection.rows, {
        loader: rowsCompiled.loader,
        ...keyedPolicy(rowsCompiled),
        ...common,
      }),
    (params) => point.decode(params as PointParams),
  );
  if (collection.window === undefined) {
    return { rows, ...reg.seal() } as AnyServedExternal;
  }

  // ── the window ──
  const full = specs as CollectionSpecs;
  const windowCompiled = compileOffFeedQuery<Row, LiveWindowParams>(
    collection.window,
    full.window,
  );
  const window = reg.register((common) =>
    defineExternalResource(collection.window, {
      loader: windowCompiled.loader,
      ...keyedPolicy(windowCompiled),
      ...(windowCompiled.validateParams !== undefined
        ? { validateParams: windowCompiled.validateParams }
        : {}),
      ...common,
    }),
  );

  // ── :groups and :count — non-keyed externals over the same SQL ──
  const groupsSpec = full.groups;
  const groups = reg.register((common) =>
    defineExternalResource<LiveGroup<FilterScalar>[], LiveGroupParams>(
      collection.groups,
      {
        mode: "push",
        loader: groupsSpec.loader,
        reach: offFeedReach(groupsSpec.reach, reason),
        ...(groupsSpec.validateParams !== undefined
          ? { validateParams: groupsSpec.validateParams }
          : {}),
        ...common,
      },
    ),
  );
  const countSpec = full.count;
  const countDescriptor = collection.count;
  const count =
    countSpec === null || countDescriptor === null
      ? null
      : reg.register((common) =>
          defineExternalResource<number, LiveCountParams>(countDescriptor, {
            mode: "push",
            loader: countSpec.loader,
            reach: offFeedReach(countSpec.reach, reason),
            ...(countSpec.validateParams !== undefined
              ? { validateParams: countSpec.validateParams }
              : {}),
            ...common,
          }),
        );
  return {
    window,
    rows,
    groups,
    count,
    ...reg.seal(),
  } as AnyServedExternal;
}
