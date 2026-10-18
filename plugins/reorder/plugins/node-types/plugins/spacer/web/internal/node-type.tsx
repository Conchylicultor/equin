import { z } from "zod";
import type { ReorderNodeType } from "@plugins/reorder/plugins/node-types/core";
import { SpacerBox } from "../components/spacer-box";

export const spacerNodeType: ReorderNodeType<Record<string, never>> = {
  type: "spacer",
  container: false,
  schema: z.object({}),
  render: (p) => (
    <SpacerBox itemKey={p.id!} editMode={p.editMode} onRemove={p.onRemove} />
  ),
  insert: {
    label: "Add Spacer",
    create: () => ({ type: "spacer", id: crypto.randomUUID() }),
  },
};
