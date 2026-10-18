import { z } from "zod";
import type { ReorderNodeType } from "@plugins/reorder/plugins/node-types/core";
import { DividerBox } from "../components/divider-box";

export const dividerNodeType: ReorderNodeType<Record<string, never>> = {
  type: "divider",
  container: false,
  schema: z.object({}),
  render: (p) => (
    <DividerBox itemKey={p.id!} editMode={p.editMode} onRemove={p.onRemove} />
  ),
  insert: {
    label: "Add Divider",
    create: () => ({ type: "divider", id: crypto.randomUUID() }),
  },
};
