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
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { ReorderTree } from "@plugins/fields/plugins/reorder-tree/core";
import { ItemBindingProvider } from "@plugins/primitives/plugins/sortable-list/plugins/deferred-item/web";
import { useReorderNodeTypes } from "@plugins/reorder/plugins/node-types/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  flowAxis,
  layoutHost,
} from "@plugins/primitives/plugins/dom/plugins/layout-host/web";
import { useEditMode } from "@plugins/primitives/plugins/edit-mode-signal/web";
import { reorderDescriptors } from "./descriptors";
import { useReorderConfig } from "./use-reorder-config";
import { ReorderEffectiveEditModeContext } from "./effective-edit-mode";
import { ReorderItemClaimContext } from "./item-claim";
import {
  applyTree,
  entryKey,
  isNodeData,
  type ReorderNodeData,
} from "./sorting";
import { ReorderLayoutContext } from "./reorder-layout";
import {
  ReorderAreaContext,
  type ReorderAreaCtxValue,
  type ReorderEntry,
} from "@plugins/reorder/plugins/area/web";
import type { ReorderRegime } from "./editor-contract";
import { fallbackNodeId, useAreaWrites } from "./area-writes";
import { useReorderAreaEditor } from "./use-area-editor";

/**
 * Below this host width (px), a horizontal reorder area in edit mode is too
 * cramped to drag in place (chrome — ring, ×-badge, placeholder, +Add — overlaps
 * the content). Instead the inline view stays clean (display-only) and editing
 * moves into a roomy vertical popover. Above it, the row wraps onto extra lines.
 * A single tunable knee matched to the conversation-progress-card host class; not
 * a prop (no host needs to override it).
 */
const POPOVER_WIDTH_THRESHOLD = 280;

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
 * The reorder render surface: applies the slot's tree over the live catalog
 * (`applyTree`) and draws the area's frame — its items, nodes and, while edit
 * mode is on, the contributed editor BESIDE them. Subscribes to NOTHING — it is
 * fed `items`/`setConfig` by the per-render-site path.
 *
 * The frame's element chain is the same in and out of edit mode (vertical
 * areas): the editor publishes drag props and item chrome into the boxes rather
 * than wrapping them, so toggling remounts no contribution. A horizontal area
 * changes shape in edit mode (the `editor-wrap` row, the `popover` regime) and
 * remounts its items there, as it always has.
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
  const editor = useReorderAreaEditor();
  // Only the edit-layout switch turns edit mode on, and it ships the editor
  // with it. Edit mode with no editor means something else flipped the signal:
  // every area would silently stay inert, so say so instead.
  if (editMode && !editor)
    throw new Error(
      "reorder: edit mode is on but no ReorderSlots.AreaEditor is registered — only reorder.edit-mode (which contributes the editor) may turn edit mode on",
    );

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

  const writes = useAreaWrites(items, state, setConfig);
  const writesRef = useLatestRef(writes);

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
        writesRef.current.patchNode(renderId, next as Record<string, unknown>);
      const onRemove = () => writesRef.current.removeNode(data.id ?? renderId);

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
                      writesRef.current.patchNode(
                        memberId,
                        np as Record<string, unknown>,
                      ),
                    onRemove: () =>
                      writesRef.current.removeNode(m.id ?? memberId),
                  })}
                </span>
              );
            }
            memberIds.push(entryKey(m));
            // CLAIMED: a container's member is a real member of THIS area (its
            // id is a sortable id of the area via `memberIds`), so it gets a claim
            // exactly like a top-level item.
            return (
              // `contents`: this span exists only to carry the React key, so it
              // must not become a layout box. Outside edit mode every wrapper
              // below it is already `display:contents` (the item box and its
              // content wrapper), so without this the span would be the ONE opaque
              // element between a container's box and its member — enough to stop
              // e.g. an overflow container's menu rows from being real children of
              // DropdownMenuContent.
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

  // --- Constrained-space regime ----------------------------------------------
  // For a horizontal area in edit mode with NO host-owned wrapping (CollapsibleWrap
  // injects `ReorderLayoutContext`), pick by measured host width (see `ReorderRegime`).
  const regime: ReorderRegime = injected
    ? "host-wrap"
    : orientation === "vertical" || !editMode
      ? "passthrough"
      : hostWidth !== null && hostWidth < POPOVER_WIDTH_THRESHOLD
        ? "popover"
        : "editor-wrap";
  const popover = editMode && regime === "popover";
  // The mode the frame draws in: in the popover regime the inline row stays at
  // rest, nodes included (a spacer's gap, a divider's rule) — the draggable
  // forms belong to the popover's own list.
  const frameEdit = editMode && !popover;

  const { entries, editEntries } = useMemo(() => {
    // One list per mode drawn: the frame's, plus the popover's editable one.
    const modes = popover ? [frameEdit, true] : [frameEdit];
    const lists = modes.map((): ReorderEntry[] => []);
    for (const entry of state.entries) {
      if (isNodeData(entry)) {
        for (const [m, edit] of modes.entries()) {
          // eslint-disable-next-line react-hooks/refs -- not a render-phase ref read: `renderNode` reads the writes via a stable ref only inside the onPatch/onRemove handlers it returns (fired on user action), never during this memo pass. The ref keeps those handlers stable so `entries` identity doesn't churn every live-state push.
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
    return { entries: lists[0]!, editEntries: lists[1] ?? null };
  }, [state.entries, renderItem, renderNode, frameEdit, popover]);

  // Stable while nothing it carries changes: the writes are stable, so a
  // live-state push never churns the area context and re-renders every item.
  const area = useMemo<ReorderAreaCtxValue>(
    () => ({
      orientation,
      onHide: writes.hide,
      onRemoveNode: writes.removeNode,
      ItemChrome: editor?.ItemChrome ?? null,
    }),
    [orientation, writes, editor],
  );

  const sentinel = (
    <div ref={sentinelRef} style={{ display: "none" }} aria-hidden />
  );

  const itemNodes = entries.map((e) => (
    <Fragment key={e.id}>{e.node}</Fragment>
  ));

  // The editor, beside the items: the drag host binding them, the restore /
  // insert affordance, or — popover regime — the trigger and popover.
  const editorNode =
    editMode && editor ? (
      <editor.Area
        regime={regime}
        orientation={orientation}
        layout={injected}
        entries={entries}
        editEntries={editEntries}
        state={state}
        renderItem={renderItem}
        writes={writes}
      />
    ) : null;

  const wrap = editMode && regime === "editor-wrap";

  return (
    <>
      {sentinel}
      <ReorderAreaContext.Provider value={area}>
        <ItemBindingProvider>
          {/* `false` makes the popover regime's inline row display-only (no
              chrome, nothing bound); `null` defers to the global signal. The
              provider is always here so entering that regime changes a value,
              not the element chain. The editor sits outside it. */}
          <ReorderEffectiveEditModeContext.Provider
            value={popover ? false : null}
          >
            {wrap ? (
              // Editor-wrap: a single honest flex parent of the cells, so a
              // horizontal row wraps instead of overflowing. Kept as one raw
              // flex parent (fill + wrap + align-content) that dnd-kit measures
              // directly. Never with a CollapsibleWrap host (`host-wrap`),
              // whose child-measurement an interposed div would break.
              // eslint-disable-next-line layout/no-adhoc-layout -- edit-mode flex-wrap fill container; single honest flex parent dnd-kit measures
              <div className="flex flex-1 flex-wrap content-start items-start gap-xs min-w-0">
                {itemNodes}
                {editorNode}
              </div>
            ) : (
              itemNodes
            )}
          </ReorderEffectiveEditModeContext.Provider>
          {wrap ? null : editorNode}
        </ItemBindingProvider>
      </ReorderAreaContext.Provider>
    </>
  );
}
