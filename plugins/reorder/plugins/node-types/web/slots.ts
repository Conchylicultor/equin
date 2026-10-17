import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { ReorderNodeType } from "@plugins/reorder/plugins/node-types/core";

export const ReorderNodes = {
  // The registry erases each node type's payload type at read time, so the
  // contribution boundary accepts any `ReorderNodeType<P>`. `schema`/`render`/
  // `onPatch` are contravariant in `P`, so `ReorderNodeType<{label?}>` is not
  // assignable to `ReorderNodeType<unknown>`; `<any>` is the standard
  // variance-erasing form for a registry slot prop (readers always treat the
  // payload as `unknown`), mirroring `Fields.Identity`.
  //
  // Companions: a committed layout may name any node type (a spacer, a header
  // group), and a layout naming one this bundle lacks cannot render. So every
  // shipped node type ships wherever the registry does.
  NodeType: defineSlot<{ nodeType: ReorderNodeType<any> }>({
    docLabel: (p) => p.nodeType.type,
    companions: true,
  }),
};
