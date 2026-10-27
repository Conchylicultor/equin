import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { useSetConfig } from "@plugins/config_v2/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { useReorderNodeTypes } from "@plugins/reorder/plugins/node-types/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  flowAxis,
  layoutHost,
} from "@plugins/primitives/plugins/dom/plugins/layout-host/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { ReorderTree } from "@plugins/fields/plugins/reorder-tree/core";
import { reorderDescriptors } from "./descriptors";
import { useReorderTree } from "./use-reorder-config";
import {
  applyTree,
  isNodeData,
  type ReorderNodeData,
  type ReorderState,
} from "./sorting";
import {
  fallbackNodeId,
  useAreaWrites,
  type ReorderAreaWrites,
} from "./area-writes";

/**
 * Applies a render slot's committed layout (`config/**\/<slot>.jsonc`): order,
 * hidden items, and the nodes the layout places between them (spacers,
 * dividers, header and overflow groups).
 *
 * Every render slot runs it, several per list row, so it costs nothing it does
 * not need: a slot with no layout directive renders its items as they come; a
 * layout of items only is one config read and a keyed list; only a layout with
 * nodes pays for the node registry, the writes a header's collapse toggle makes,
 * and — what a divider reads — the host's measured flow.
 */
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
  // slot share one directive; subIds aren't known at build time). None — a
  // runtime-only render slot, or an unresolved id — renders naturally.
  const descriptor = reorderDescriptors.get(slotId);
  if (!descriptor) {
    return <>{contributions.map((c) => renderItem(c))}</>;
  }
  return (
    <ReorderArea
      descriptor={descriptor}
      contributions={contributions}
      renderItem={renderItem}
    />
  );
}

/**
 * Per-render-site path: one config read, then the area.
 *
 * Renders NOTHING until the slot's layout is known. Drawing the contributions
 * in raw order meanwhile would show hidden ones and then jump to the layout;
 * mounting nothing also means no item is mounted and then remounted when the
 * layout lands (no churn), and no node write can be computed over an empty
 * tree. A failed read with a last-known layout keeps drawing it — the SAME
 * `ReorderKnownArea` element as the ready arm, so a transient error remounts
 * nothing; a failure with nothing known draws nothing.
 */
function ReorderArea({
  descriptor,
  contributions,
  renderItem,
}: {
  descriptor: ConfigDescriptor;
  contributions: readonly Contribution[];
  renderItem: (contribution: Contribution) => ReactNode;
}) {
  const tree = foldResource(useReorderTree(descriptor), {
    loading: () => null,
    error: (_error, stale: ReorderTree | undefined) => stale ?? null,
    ready: (t: ReorderTree) => t,
  });
  if (tree === null) return null;
  return (
    <ReorderKnownArea
      descriptor={descriptor}
      items={tree}
      contributions={contributions}
      renderItem={renderItem}
    />
  );
}

function ReorderKnownArea({
  descriptor,
  items,
  contributions,
  renderItem,
}: {
  descriptor: ConfigDescriptor;
  items: ReorderTree;
  contributions: readonly Contribution[];
  renderItem: (contribution: Contribution) => ReactNode;
}) {
  const state = useMemo(
    () => applyTree(contributions, items),
    [contributions, items],
  );
  if (state.entries.some(isNodeData)) {
    return (
      <ReorderNodesArea
        descriptor={descriptor}
        items={items}
        state={state}
        renderItem={renderItem}
      />
    );
  }
  // `renderItem` keys each item by its entryKey itself.
  return <>{state.entries.map((e) => renderItem(e as Contribution))}</>;
}

/** An area whose layout places nodes between its items. */
function ReorderNodesArea({
  descriptor,
  items,
  state,
  renderItem,
}: {
  descriptor: ConfigDescriptor;
  items: ReorderTree;
  state: ReorderState;
  renderItem: (contribution: Contribution) => ReactNode;
}) {
  const setConfig = useSetConfig(descriptor);
  const nodeTypes = useReorderNodeTypes();
  // Stable: the writes read the latest tree when they fire.
  const writes = useAreaWrites(items, state, setConfig);

  // The host's flow, for the nodes that turn to it (a divider's rule stands
  // upright in a row). The host is the box that lays the sentinel out
  // (`layoutHost`), not its `parentElement`: a `display: contents` wrapper (the
  // app-shell sidebar's) has no box. The primitive RAF-debounces resizes and
  // runs the initial measure synchronously (no timers; repo rule).
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [orientation, setOrientation] = useState<"horizontal" | "vertical">(
    "vertical",
  );
  const host = () => {
    const sentinel = sentinelRef.current;
    return sentinel ? layoutHost(sentinel) : null;
  };
  useResizeObserver(host, () => {
    const el = host();
    if (!el) return;
    setOrientation(flowAxis(el) === "row" ? "horizontal" : "vertical");
  });

  const nodes: NodeRenderContext = {
    nodeTypes,
    orientation,
    renderItem,
    writes,
  };

  return (
    <>
      <div ref={sentinelRef} style={{ display: "none" }} aria-hidden />
      {state.entries.map((e) =>
        isNodeData(e) ? (
          <Fragment key={e.id ?? fallbackNodeId(e)}>
            {renderNode(e, nodes)}
          </Fragment>
        ) : (
          renderItem(e)
        ),
      )}
    </>
  );
}

interface NodeRenderContext {
  nodeTypes: ReturnType<typeof useReorderNodeTypes>;
  orientation: "horizontal" | "vertical";
  renderItem: (contribution: Contribution) => ReactNode;
  writes: ReorderAreaWrites;
}

/** One node of a layout at rest, its container members drawn inside it. */
function renderNode(data: ReorderNodeData, ctx: NodeRenderContext): ReactNode {
  const nodeType = ctx.nodeTypes.get(data.type);
  if (!nodeType) return null; // unknown type → fail-soft skip
  const parsed = nodeType.schema.safeParse(data.payload);
  const payload = parsed.success ? parsed.data : {};
  const renderId = data.id ?? fallbackNodeId(data);

  let children: ReactNode = undefined;
  if (
    nodeType.container &&
    (payload as { collapsed?: boolean }).collapsed !== true
  ) {
    children = (data.members ?? []).map((m) =>
      isNodeData(m) ? (
        // `contents`: this span exists only to carry the React key, so it must
        // not become a layout box between a container and its member — what
        // lets an overflow container's rows be real children of
        // DropdownMenuContent.
        <span key={m.id ?? fallbackNodeId(m)} className="contents">
          {renderNode(m, ctx)}
        </span>
      ) : (
        // Keyed by `renderItem` itself.
        ctx.renderItem(m)
      ),
    );
  }
  return nodeType.render({
    payload,
    id: nodeType.container ? data.id : renderId,
    editMode: false,
    orientation: ctx.orientation,
    children,
    onPatch: (next) =>
      ctx.writes.patchNode(renderId, next as Record<string, unknown>),
    onRemove: () => ctx.writes.removeNode(data.id ?? renderId),
  });
}
