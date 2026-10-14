import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { rectSortingStrategy } from "@plugins/primitives/plugins/sortable-list/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type {
  ReorderNode,
  ReorderTree,
} from "@plugins/fields/plugins/reorder-tree/core";
import {
  ReorderAreaContext,
  ReorderEditor,
  type ReorderAreaCtxValue,
  type ReorderEntry,
} from "@plugins/reorder/plugins/editor/web";
import { useReorderNodeTypes } from "@plugins/reorder/plugins/node-types/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  flowAxis,
  layoutHost,
} from "@plugins/primitives/plugins/dom/plugins/layout-host/web";
import { reorderDescriptors } from "./descriptors";
import { useReorderConfig } from "./use-reorder-config";
import { useEditMode } from "@plugins/primitives/plugins/edit-mode-signal/web";
import { ReorderEffectiveEditModeContext } from "./effective-edit-mode";
import { ReorderItemClaimContext } from "./item-claim";
import {
  applyTree,
  contributionKey,
  contributionLabel,
  entryKey,
  isNodeData,
  type ReorderNodeData,
  type TopLevelEntry,
} from "./sorting";
import { ReorderLayoutContext } from "./reorder-layout";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const tuneIcon = symbol("tune");

/**
 * Below this host width (px), a horizontal reorder area in edit mode is too
 * cramped to drag in place (chrome — ring, ×-badge, placeholder, +Add — overlaps
 * the content). Instead the inline view stays clean (display-only) and editing
 * moves into a roomy vertical popover. Above it, the row wraps onto extra lines.
 * A single tunable knee matched to the conversation-progress-card host class; not
 * a prop (no host needs to override it).
 */
const POPOVER_WIDTH_THRESHOLD = 280;

/**
 * Serialize one top-level entry to a `ReorderNode`:
 *  - a live `Contribution` → its bare `entryKey` string (terse item);
 *  - a node (`ReorderNodeData`) → its `rawNode` VERBATIM (a container rides
 *    along with its members/payload unchanged; a leaf node keeps its `id`/payload).
 */
function entryToNode(entry: TopLevelEntry): ReorderNode {
  return isNodeData(entry) ? entry.rawNode : entryKey(entry);
}

/**
 * Materialize the current top-level order into a fresh `ReorderTree`:
 * contributions become bare strings, node entries re-emit their raw subtree
 * verbatim, and the hidden set is appended last as `{ item, hidden: true }`
 * nodes so a reorder/insert write never un-hides. Containers ride along at
 * their array positions (they are not top-level draggable).
 *
 * `hideKey`/`restoreKey` flip a single contribution to/from hidden.
 */
function materializeTree(
  entries: TopLevelEntry[],
  hiddenKeys: string[],
  opts?: { hideKey?: string; restoreKey?: string },
): ReorderTree {
  const tree: ReorderNode[] = [];
  for (const e of entries) {
    if (!isNodeData(e)) {
      const key = entryKey(e);
      if (key === opts?.hideKey) {
        tree.push({ item: key, hidden: true });
        continue;
      }
    }
    tree.push(entryToNode(e));
  }
  for (const key of hiddenKeys) {
    if (key === opts?.hideKey) continue;
    if (key === opts?.restoreKey) {
      tree.push(key);
    } else {
      tree.push({ item: key, hidden: true });
    }
  }
  return tree;
}

/**
 * Verbatim map over the raw `items` tree, applied to the node matching `id` at
 * the top level OR one level inside a container. Returning `null` from `fn`
 * removes the node; returning a `ReorderNode` replaces it. Reads never call this
 * — only in-app writes (patch/remove).
 */
function mapNodeById(
  tree: ReorderTree,
  id: string,
  fn: (node: ReorderNode) => ReorderNode | null,
): ReorderTree {
  const out: ReorderNode[] = [];
  for (const node of tree) {
    if (typeof node === "object" && "type" in node && node.id === id) {
      const next = fn(node);
      if (next !== null) out.push(next);
      continue;
    }
    if (
      typeof node === "object" &&
      "type" in node &&
      Array.isArray(node.items)
    ) {
      // Recurse one level into a container's members.
      const items: ReorderNode[] = [];
      let touched = false;
      for (const member of node.items) {
        if (
          typeof member === "object" &&
          "type" in member &&
          member.id === id
        ) {
          touched = true;
          const next = fn(member);
          if (next !== null) items.push(next);
          continue;
        }
        items.push(member);
      }
      out.push(touched ? { ...node, items } : node);
      continue;
    }
    out.push(node);
  }
  return out;
}

export function ReorderListMiddleware({
  slotId,
  contributions,
  renderItem,
}: {
  slotId: string;
  contributions: readonly Contribution[];
  renderItem: (contribution: Contribution) => ReactNode;
  children: ReactNode;
}) {
  // The descriptor is looked up by the base `slotId` (sub-instances of a render
  // slot share one directive; subIds aren't known at build time).
  const descriptor = reorderDescriptors.get(slotId);

  // No descriptor (runtime-only render slot, a mount slot, or unresolved id)
  // → render naturally with no reorder applied.
  //
  // NOT claimed, deliberately: this path mounts no reorder area of its own, so
  // its contributions are members of nothing. Claiming them here would hand them
  // to whichever ancestor area happens to enclose this slot — the same
  // inheritance bug the claim exists to close.
  if (!descriptor) {
    return <>{contributions.map((c) => renderItem(c))}</>;
  }

  return (
    <ReorderListMiddlewareInner
      descriptor={descriptor}
      contributions={contributions}
      renderItem={renderItem}
    />
  );
}

/**
 * Per-render-site path: subscribes for itself, then renders. The config
 * subscription is shared + kept alive at the live-state layer, so one
 * subscription per render site is cheap even for per-row reorderable slots.
 */
function ReorderListMiddlewareInner({
  descriptor,
  contributions,
  renderItem,
}: {
  descriptor: ConfigDescriptor;
  contributions: readonly Contribution[];
  renderItem: (contribution: Contribution) => ReactNode;
}) {
  const { items, setConfig } = useReorderConfig(descriptor);
  return (
    <ReorderInner
      items={items}
      setConfig={setConfig}
      contributions={contributions}
      renderItem={renderItem}
    />
  );
}

/**
 * The reorder render surface: derives the live catalog (`applyTree`), the
 * drag/hide/insert/remove/patch handlers, and the presentational entries from
 * the host's own `contributions` + `renderItem`, and renders `<ReorderEditor>`.
 * Subscribes to NOTHING — it is fed `items`/`setConfig` by the per-render-site
 * path.
 */
function ReorderInner({
  items,
  setConfig,
  contributions,
  renderItem,
}: {
  items: ReorderTree;
  setConfig: (key: string, value: unknown) => void;
  contributions: readonly Contribution[];
  renderItem: (contribution: Contribution) => ReactNode;
}) {
  const editMode = useEditMode();
  const injected = useContext(ReorderLayoutContext);
  const nodeTypes = useReorderNodeTypes();

  const [popoverOpen, setPopoverOpen] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const [orientation, setOrientation] = useState<"horizontal" | "vertical">(
    "vertical",
  );
  // `null` until first measured — regime defaults to wrap (never overlaps) until
  // a real width is known, so we don't flash a collapse-into-popover on mount.
  const [hostWidth, setHostWidth] = useState<number | null>(null);

  const state = useMemo(
    () => applyTree(contributions, items),
    [contributions, items],
  );
  // Who reads the measurement: the edit-mode chrome (the regime, the item
  // boxes' axis) and, at rest, only the nodes an area draws itself — a divider
  // turns its rule upright in a row. An area of plain contributions at rest
  // reads neither, so it measures nothing: every render slot is an area,
  // several per list row, and each measure is a style + layout read in the
  // commit that mounted it.
  const measured = editMode || state.entries.some(isNodeData);
  // Measure the host for BOTH flow axis and width. The host is the box that
  // lays the sentinel out (`layoutHost`), not its `parentElement`: a
  // `display: contents` wrapper (the app-shell sidebar's) has no box — width 0,
  // never resizes — and would fold every sidebar into the narrow-row popover.
  // The primitive RAF-debounces resizes and runs the initial measure
  // synchronously (no timers; repo rule). The getter resolves the host at
  // observe time, since the sentinel may not be mounted on the first render.
  const host = () => {
    const sentinel = sentinelRef.current;
    return measured && sentinel ? layoutHost(sentinel) : null;
  };
  useResizeObserver(
    host,
    () => {
      const el = host();
      if (!el) return;
      setOrientation(flowAxis(el) === "row" ? "horizontal" : "vertical");
      setHostWidth(el.clientWidth);
    },
    { deps: [measured] },
  );

  const hiddenItems = useMemo(
    () =>
      state.hidden.map((c) => ({
        key: contributionKey(c)!,
        label: contributionLabel(c),
      })),
    [state.hidden],
  );

  // --- Refs for handlers -----------------------------------------------------

  const entriesRef = useLatestRef(state.entries);
  // `itemsRef` feeds the verbatim raw-tree maps (remove/patch by id) — the same
  // tree `entriesRef` is derived from.
  const itemsRef = useLatestRef(items);
  const hiddenKeysRef = useLatestRef(
    useMemo(() => state.hidden.map((c) => contributionKey(c)!), [state.hidden]),
  );

  // --- Write sink ------------------------------------------------------------
  // Every in-app edit funnels its freshly-materialized tree through this single
  // choke-point, which writes the user config layer.
  const commitTree = useCallback(
    (tree: ReorderTree) => {
      setConfig("items", tree);
    },
    [setConfig],
  );
  const commitTreeRef = useLatestRef(commitTree);

  // --- Hide / restore (config-backed) ---------------------------------------

  const hideItem = useCallback((key: string) => {
    if (hiddenKeysRef.current.includes(key)) return;
    commitTreeRef.current(
      materializeTree(entriesRef.current, hiddenKeysRef.current, {
        hideKey: key,
      }),
    );
  }, []);

  const restoreItem = useCallback((key: string) => {
    if (!hiddenKeysRef.current.includes(key)) return;
    commitTreeRef.current(
      materializeTree(entriesRef.current, hiddenKeysRef.current, {
        restoreKey: key,
      }),
    );
  }, []);

  // --- Drag reorder ----------------------------------------------------------

  const onDrop = useCallback((draggedKey: string, overKey: string) => {
    if (draggedKey === overKey) return;
    const list = entriesRef.current;

    const idOf = (e: TopLevelEntry): string =>
      isNodeData(e) ? (e.id ?? "") : entryKey(e);
    const excludedOf = (e: TopLevelEntry): boolean =>
      !isNodeData(e) && !!(e as Record<string, unknown>).excludeFromReorder;

    const dragged = list.find((x) => idOf(x) === draggedKey);
    const target = list.find((x) => idOf(x) === overKey);
    if (!dragged || !target) return;
    // Containers are not top-level draggable; only items move.
    if (isNodeData(dragged) && dragged.members) return;
    if (excludedOf(dragged) || excludedOf(target)) return;

    // Reorder over the non-excluded slice, then materialize the full order.
    const reorderable = list.filter((x) => !excludedOf(x));
    const fromIdx = reorderable.findIndex((x) => idOf(x) === draggedKey);
    const toIdx = reorderable.findIndex((x) => idOf(x) === overKey);
    if (fromIdx < 0 || toIdx < 0) return;

    const next = reorderable.slice();
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved!);

    // Re-append the excluded tail (pinned last) so it isn't dropped.
    const tail = list.filter((x) => excludedOf(x));
    commitTreeRef.current(
      materializeTree([...next, ...tail], hiddenKeysRef.current),
    );
  }, []);

  // --- Inserts (registry-driven) --------------------------------------------

  // Append the freshly-materialized tree with one new node and commit it. A
  // stable callback so the `inserts` memo below holds no ref reads in its body
  // (the latest entries/hidden/commit are read here, off render).
  const doInsert = useCallback((create: () => ReorderNode) => {
    const tree = materializeTree(entriesRef.current, hiddenKeysRef.current);
    tree.push(create());
    commitTreeRef.current(tree);
  }, []);

  const inserts = useMemo(() => {
    const out: Array<{ label: string; onInsert: () => void }> = [];
    for (const nt of nodeTypes.values()) {
      const insert = nt.insert;
      if (!insert) continue;
      // eslint-disable-next-line react-hooks/refs -- not a render-phase ref read: `onInsert` is a deferred click handler, and `doInsert` reads the latest entries/hidden/commit via stable refs only when it FIRES. Reading those values directly in this memo would churn `inserts` identity on every live-state push and re-render every draggable item app-wide (the stability `editorProps` deliberately holds).
      out.push({
        label: insert.label,
        onInsert: () => doInsert(insert.create),
      });
    }
    return out;
  }, [nodeTypes, doInsert]);

  // --- Remove a node by id ---------------------------------------------------

  const onRemoveNode = useCallback((id: string) => {
    commitTreeRef.current(mapNodeById(itemsRef.current, id, () => null));
  }, []);

  const onRemoveNodeRef = useLatestRef(onRemoveNode);

  // --- Patch a node's payload by id (e.g. header collapse toggle) ------------
  // Addresses the node by `id`; a container without an `id` (hand-authored)
  // gets a lazily-assigned uuid in the same write. `positionalId` is the
  // render-time fallback id used as the key when the node has no persisted id;
  // we resolve it back to the matching raw node positionally.

  const patchNode = useCallback(
    (renderId: string, partial: Record<string, unknown>) => {
      // Find the addressed node-data among top-level entries OR one level inside
      // a container, by persisted id first, else by positional fallback id.
      let target: ReorderNodeData | undefined;
      for (const e of entriesRef.current) {
        if (!isNodeData(e)) continue;
        if ((e.id ?? fallbackNodeId(e)) === renderId) {
          target = e;
          break;
        }
        for (const m of e.members ?? []) {
          if (isNodeData(m) && (m.id ?? fallbackNodeId(m)) === renderId) {
            target = m;
            break;
          }
        }
        if (target) break;
      }
      if (!target) return;

      // Persisted id → verbatim id-addressed map (top-level or one level deep).
      if (target.id) {
        commitTreeRef.current(
          mapNodeById(itemsRef.current, target.id, (node) => {
            if (typeof node === "string" || "item" in node) return node;
            return { ...node, ...partial };
          }),
        );
        return;
      }

      // No persisted id (hand-authored): locate the rawNode by reference and
      // assign a lazy uuid in the same write. Containers are top-level only
      // (no-nesting), so an id-less header is always a top-level node.
      const rawTarget = target.rawNode;
      const next = itemsRef.current.map((node) =>
        node === rawTarget && typeof node === "object" && "type" in node
          ? { ...node, id: crypto.randomUUID(), ...partial }
          : node,
      );
      commitTreeRef.current(next);
    },
    [],
  );

  const patchNodeRef = useLatestRef(patchNode);

  // --- Map state into the editor's presentational entries --------------------

  // `edit` is the mode the node draws in — passed, not read from the global
  // signal, because the popover regime draws the same nodes twice: editable
  // in its popover, and at rest in its display-only inline row.
  const renderNode = useCallback(
    (data: ReorderNodeData, edit: boolean): ReorderEntry | null => {
      const nodeType = nodeTypes.get(data.type);
      if (!nodeType) return null; // unknown type → fail-soft skip
      const parsed = nodeType.schema.safeParse(data.payload);
      const payload = parsed.success ? parsed.data : {};

      const renderId = data.id ?? fallbackNodeId(data);

      const onPatch = (next: unknown) =>
        patchNodeRef.current(renderId, next as Record<string, unknown>);
      const onRemove = () => onRemoveNodeRef.current(data.id ?? renderId);

      if (nodeType.container) {
        const collapsed =
          (payload as { collapsed?: boolean }).collapsed === true;
        const memberIds: string[] = [];
        let children: ReactNode = null;
        if (!collapsed) {
          children = (data.members ?? []).map((m) => {
            if (isNodeData(m)) {
              const memberType = nodeTypes.get(m.type);
              if (!memberType) return null;
              const memberParsed = memberType.schema.safeParse(m.payload);
              const memberId = m.id ?? fallbackNodeId(m);
              memberIds.push(memberId);
              return (
                // `contents` — see the sibling item member below.
                <span key={memberId} className="contents">
                  {memberType.render({
                    payload: memberParsed.success ? memberParsed.data : {},
                    id: m.id,
                    editMode: edit,
                    onPatch: (np: unknown) =>
                      patchNodeRef.current(
                        memberId,
                        np as Record<string, unknown>,
                      ),
                    onRemove: () => onRemoveNodeRef.current(m.id ?? memberId),
                  })}
                </span>
              );
            }
            memberIds.push(entryKey(m));
            // CLAIMED: a container's member is a real member of THIS area (its
            // id is registered in the shared SortableContext via `memberIds`),
            // so it gets a claim exactly like a top-level item.
            return (
              // `contents`: this span exists only to carry the React key, so it
              // must not become a layout box. Outside edit mode every wrapper
              // below it is already `display:contents` (SortableReorderItem's
              // itemClassName and its content div), so without this the span
              // would be the ONE opaque element between a container's box and
              // its member — enough to stop e.g. an overflow container's menu
              // rows from being real children of DropdownMenuContent.
              <span key={entryKey(m)} className="contents">
                <ReorderItemClaimContext.Provider value={true}>
                  {renderItem(m)}
                </ReorderItemClaimContext.Provider>
              </span>
            );
          });
        }
        return {
          kind: "node",
          id: renderId,
          memberIds,
          node: nodeType.render({
            payload,
            id: data.id,
            editMode: edit,
            children,
            onPatch,
            onRemove,
          }),
        };
      }

      // Leaf node (e.g. spacer).
      return {
        kind: "node",
        id: renderId,
        node: nodeType.render({
          payload,
          id: renderId,
          editMode: edit,
          onPatch,
          onRemove,
        }),
      };
    },
    [renderItem, nodeTypes],
  );

  // The drag overlay re-renders the active contribution (catalog-aware); node
  // ids resolve to null (nodes aren't top-level draggable).
  const renderOverlay = useCallback(
    (activeId: string) => {
      const entry = entriesRef.current.find(
        (x) => !isNodeData(x) && entryKey(x) === activeId,
      );
      if (!entry || isNodeData(entry)) return null;

      // Fill contributions render a height-filling, internally-scrolling body
      // (e.g. the Conversations sidebar section). Re-rendering that live as the
      // drag overlay produces a tall floating panel — wrong for a "pick up this
      // section" gesture. Show a compact label chip instead, using the human
      // label the slot already exposes via `docLabel` (id fallback). Gated on the
      // same first-class `fill` flag that bounds the edit-mode wrapper, so
      // the primitive stays generic (never reads app-shell's title/icon).
      if ((entry as Record<string, unknown>).fill) {
        const label = entry._doc?.label ?? contributionLabel(entry);
        return (
          <div className="cursor-grabbing rounded-md border border-primary/50 bg-background/95 px-sm py-2xs shadow-lg ring-1 ring-primary/50">
            <Badge variant="primary">{label}</Badge>
          </div>
        );
      }

      // NOT claimed, deliberately: the overlay is a PREVIEW of the dragged
      // contribution, not a member of the area. `DragOverlayWrapper` lives inside
      // the same `DndContext` as the list, so claiming it would register the
      // dragged id a SECOND time for the duration of the drag (a duplicate that
      // predates this fix). Unclaimed, it renders the bare contribution — it
      // loses the item chrome (ring / ×-badge) inside the box below, which is
      // accepted; re-claiming is not the fix if that preview ever looks wrong.
      return (
        <div className="rounded-md border border-border bg-background/90 shadow-lg">
          {renderItem(entry)}
        </div>
      );
    },
    [renderItem],
  );

  // --- Constrained-space regime ----------------------------------------------
  // For a horizontal area in edit mode with NO host-owned wrapping (CollapsibleWrap
  // injects `ReorderLayoutContext`), pick by measured host width:
  //   • "host-wrap"   — host owns wrapping → render exactly as before.
  //   • "passthrough" — vertical or non-edit → no chrome overflow → render as before.
  //   • "editor-wrap" — wide enough → editor-owned flex-wrap so items stack, not overlap.
  //   • "popover"     — too narrow → clean display-only inline + edit in a vertical popover.
  const regime: "host-wrap" | "passthrough" | "editor-wrap" | "popover" =
    injected
      ? "host-wrap"
      : orientation === "vertical" || !editMode
        ? "passthrough"
        : hostWidth !== null && hostWidth < POPOVER_WIDTH_THRESHOLD
          ? "popover"
          : "editor-wrap";

  // The editor's entries, and — in the popover regime — the inline row's. That
  // row is display-only, nodes included: they draw their at-rest form there (a
  // spacer's gap, a divider's rule), never the draggable placeholder, which
  // belongs to the popover's editor.
  const { entries, inlineEntries } = useMemo(() => {
    // One list per mode drawn: the editor's, plus the inline row's at rest.
    const modes = regime === "popover" ? [editMode, false] : [editMode];
    const lists = modes.map((): ReorderEntry[] => []);
    for (const entry of state.entries) {
      if (isNodeData(entry)) {
        for (const [m, edit] of modes.entries()) {
          // eslint-disable-next-line react-hooks/refs -- not a render-phase ref read: `renderNode` reads patchNode/onRemoveNode via stable refs only inside the onPatch/onRemove handlers it returns (fired on user action), never during this memo pass. The refs keep those handlers stable so `entries` identity doesn't churn every live-state push.
          const mapped = renderNode(entry, edit);
          if (mapped) lists[m]!.push(mapped);
        }
        continue;
      }
      const item: ReorderEntry = {
        kind: "item",
        id: entryKey(entry),
        excluded: !!(entry as Record<string, unknown>).excludeFromReorder,
        // CLAIMED: this is THE site that makes a contribution an item of this
        // area. The provider lands directly above the item middleware's element
        // (`renderItem` applies the item middlewares inside itself), which
        // consumes the claim and resets it to `false` for everything below — so
        // a slot dispatched from inside the contribution can never inherit it.
        node: (
          <ReorderItemClaimContext.Provider value={true}>
            {renderItem(entry)}
          </ReorderItemClaimContext.Provider>
        ),
      };
      for (const list of lists) list.push(item);
    }
    return { entries: lists[0]!, inlineEntries: lists[1] ?? null };
  }, [state.entries, renderItem, renderNode, editMode, regime]);

  const wrap = regime === "editor-wrap";
  const strategy =
    injected?.strategy ?? (wrap ? rectSortingStrategy : undefined);

  // Shared callback wiring. These are passed straight through — each is already
  // a stable `useCallback([])` reading fresh state via internal refs (commitTree,
  // entries, hiddenKeys). Wrapping them in fresh inline arrows here would defeat
  // that stability: `onHide`/`onRemoveNode` feed `ReorderEditor`'s `ctxValue`
  // useMemo, so a new identity each render churns `ReorderAreaContext` and
  // re-renders every draggable item app-wide on every live-state push.
  const editorProps = {
    entries,
    hiddenItems,
    onDrop,
    onHide: hideItem,
    onRestore: restoreItem,
    inserts,
    onRemoveNode,
    renderOverlay,
  };

  const sentinel = (
    <div ref={sentinelRef} style={{ display: "none" }} aria-hidden />
  );

  // The popover regime's inline render is outside any `ReorderEditor`, so it
  // provides the area itself: the nodes it draws (a divider turning its rule
  // upright in a row) read the orientation off the area, and without this they
  // would read an enclosing area's — or none, and default to vertical.
  const inlineArea = useMemo<ReorderAreaCtxValue>(
    () => ({ orientation, onHide: hideItem, onRemoveNode }),
    [orientation, hideItem, onRemoveNode],
  );

  if (inlineEntries !== null) {
    return (
      <>
        {sentinel}
        {/* Inline: the live contributions in DISPLAY mode (override forces every
            item/node non-draggable, no chrome, no SortableContext). */}
        <ReorderAreaContext.Provider value={inlineArea}>
          <ReorderEffectiveEditModeContext.Provider value={false}>
            {inlineEntries.map((e) => (
              <Fragment key={e.id}>{e.node}</Fragment>
            ))}
          </ReorderEffectiveEditModeContext.Provider>
        </ReorderAreaContext.Provider>
        {/* Editing happens in a roomy vertical popover — the only drag surface. */}
        <InlinePopover
          resetOnClose
          open={popoverOpen}
          onOpenChange={setPopoverOpen}
          tooltip="Edit layout"
          trigger={
            <Button
              variant="ghost"
              aspect="icon"
              aria-label="Edit layout"
              // Stop the pointerdown from reaching an ancestor reorder item's
              // dnd-kit sensor (which would capture the pointer and swallow the
              // popover-trigger click) — same guard the hide/spacer buttons use.
              onPointerDown={(e) => e.stopPropagation()}
              // `pointer-events-auto` re-enables the trigger when this area is
              // nested inside another reorder item, whose edit-mode content
              // wrapper is `pointer-events-none`. The popover content portals to
              // <body>, escaping that trap — so a nested narrow area becomes
              // editable here even though inline drag never was.
              // `shrink-0` keeps this rigid trigger from being crushed in the
              // narrow horizontal reorder band it sits in.
              // eslint-disable-next-line layout/no-adhoc-layout -- rigid popover-trigger leaf in the constrained horizontal reorder band
              className="shrink-0 pointer-events-auto"
            >
              <Icon icon={tuneIcon} className="size-3.5" />
            </Button>
          }
          width="lg"
          padding="xs"
        >
          <ReorderEditor {...editorProps} editMode orientation="vertical" />
        </InlinePopover>
      </>
    );
  }

  return (
    <>
      {sentinel}
      <ReorderEditor
        {...editorProps}
        editMode={editMode}
        orientation={orientation}
        strategy={strategy}
        wrap={wrap}
      />
    </>
  );
}

/**
 * Stable render/addressing id for a node with no persisted `id` (hand-authored).
 * Used only as the React key + addressing handle until the first in-app write
 * assigns a real uuid. Stable across renders because it is derived purely from
 * the node's verbatim raw shape.
 */
function fallbackNodeId(data: ReorderNodeData): string {
  return `__node:${data.type}:${JSON.stringify(data.rawNode)}`;
}
