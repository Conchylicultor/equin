import { useMemo } from "react";
import type {
  FieldShape,
  FieldShapeProps,
} from "@plugins/config_v2/plugins/fields/core";
import { defineFieldShape } from "@plugins/config_v2/plugins/fields/web";
import {
  reorderTreeFieldType,
  type ReorderTree,
} from "@plugins/fields/plugins/reorder-tree/core";
import { ReorderEditor } from "@plugins/reorder/plugins/editor/web";
import {
  ReorderItemBox,
  type ReorderEntry,
} from "@plugins/reorder/plugins/area/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useReorderNodeTypes } from "@plugins/reorder/plugins/node-types/web";
import {
  treeToView,
  reorderTree,
  hideInTree,
  restoreInTree,
  removeNode,
  patchNode,
  insertNode,
} from "./tree-ops";

// Full drag editor for a reorder-tree field in the Config settings pane. It maps
// the saved `ReorderTree` into the shared `<ReorderEditor>` and persists every
// edit via the field's `onChange`. There's no live catalog here, so items are
// labeled by their raw `entryKey` string, and container members render as label
// chips. Every node type (spacer, header, …) is rendered through the contributed
// `reorder.node-type` registry — the config pane hardcodes none of them.

/** A plain entryKey label chip, wrapped as a draggable item. */
function ItemChip({ id }: { id: string }) {
  return (
    <ReorderItemBox itemKey={id} editMode label={id}>
      <Text variant="body" className="px-sm py-xs font-mono">
        {id}
      </Text>
    </ReorderItemBox>
  );
}

/**
 * A drag editor is far wider than a row, so the shape is a `block`: the panel
 * draws the label, and the editor lands on the panel's rail by doing nothing.
 */
function useReorderTreeShape({
  value,
  onChange,
}: FieldShapeProps<ReorderTree>): FieldShape {
  const nodeTypes = useReorderNodeTypes();

  const { entries, hiddenItems } = useMemo(() => {
    const view = treeToView(value);
    const editorEntries: ReorderEntry[] = [];
    for (const e of view.entries) {
      if (e.kind === "item") {
        editorEntries.push({
          kind: "item",
          id: e.id,
          node: <ItemChip id={e.id} />,
        });
        continue;
      }
      const nodeType = nodeTypes.get(e.type);
      if (!nodeType) continue; // unknown type → fail-soft skip
      const parsed = nodeType.schema.safeParse(e.payload);
      const payload = parsed.success ? parsed.data : {};
      const onPatch = (p: Record<string, unknown>) =>
        onChange(patchNode(value, e.viewId, p));
      const onRemove = () => onChange(removeNode(value, e.viewId));

      if (e.members !== undefined) {
        // Container node: render members as label chips passed as children.
        const collapsed =
          typeof (payload as { collapsed?: unknown }).collapsed === "boolean" &&
          (payload as { collapsed: boolean }).collapsed;
        const children = collapsed ? undefined : (
          <>
            {e.members.map((m) => (
              <ItemChip key={m.id} id={m.id} />
            ))}
          </>
        );
        editorEntries.push({
          kind: "node",
          id: e.viewId,
          memberIds: collapsed ? [] : e.members.map((m) => m.id),
          node: nodeType.render({
            payload,
            id: e.id,
            editMode: true,
            children,
            onPatch,
            onRemove,
          }),
        });
        continue;
      }

      // Leaf node (e.g. spacer).
      editorEntries.push({
        kind: "node",
        id: e.viewId,
        node: nodeType.render({
          payload,
          id: e.id,
          editMode: true,
          onPatch,
          onRemove,
        }),
      });
    }
    return { entries: editorEntries, hiddenItems: view.hiddenItems };
  }, [value, nodeTypes, onChange]);

  const inserts = useMemo(
    () =>
      Array.from(nodeTypes.values())
        .filter((t) => t.insert !== undefined)
        .map((t) => ({
          label: t.insert!.label,
          onInsert: () => onChange(insertNode(value, t.insert!.create())),
        })),
    [nodeTypes, value, onChange],
  );

  return {
    kind: "block",
    control: (
      <ReorderEditor
        entries={entries}
        hiddenItems={hiddenItems}
        onDrop={(a, o) => onChange(reorderTree(value, a, o))}
        onHide={(k) => onChange(hideInTree(value, k))}
        onRestore={(k) => onChange(restoreInTree(value, k))}
        inserts={inserts}
        onRemoveNode={(id) => onChange(removeNode(value, id))}
        editMode
        orientation="vertical"
      />
    ),
  };
}

const ReorderTreeRenderer = defineFieldShape({
  type: reorderTreeFieldType,
  useShape: useReorderTreeShape,
});

export { ReorderTreeRenderer };
