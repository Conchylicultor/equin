import { useCallback, type ReactNode } from "react";
import {
  useRawContributions,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  defineDispatchSlot,
  renderIsolated,
} from "@plugins/primitives/plugins/slot-render/web";
import { resolveTypeChain } from "@plugins/fields/core";
import type { CellEditorProps, FieldDef, FieldValue } from "../core";
import { useFieldIdentities } from "./internal/use-field-identities";

/**
 * Per-type inline cell editor slot. Contributors call `DataViewSlots.CellEditor({ match, component })`.
 * Resolution is custom (`useResolveCellEditor`) so it can walk the `extends` chain —
 * `defineDispatchSlot`'s built-in `.Dispatch` can't.
 */
const CellEditor = defineDispatchSlot<CellEditorProps>({
  key: (p) => p.field.type ?? "text",
  docLabel: (c) => (typeof c.match === "string" ? c.match : undefined),
});

interface ResolveCellEditorArgs {
  field: FieldDef<unknown>;
  value: FieldValue;
  values?: readonly string[];
  raw: unknown;
  onCommit: (next: FieldValue) => void;
  onCommitValues: (next: string[]) => void;
  onCancel: () => void;
}

/** Returns a renderer that resolves a field's type editor honoring `extends`, or undefined. */
export function useResolveCellEditor(): (
  args: ResolveCellEditorArgs,
) => ReactNode | undefined {
  const identities = useFieldIdentities();
  const raw0 = useRawContributions(CellEditor);
  return useCallback(
    ({ field, value, values, raw, onCommit, onCommitValues, onCancel }) => {
      const chain = resolveTypeChain(field.type ?? "text", identities);
      for (const typeId of chain) {
        const contribution = raw0.find(
          (c) => (c as { match?: unknown }).match === typeId,
        ) as Contribution | undefined;
        if (contribution) {
          return renderIsolated(CellEditor, contribution, {
            value,
            values,
            field,
            raw,
            onCommit,
            onCommitValues,
            onCancel,
          } satisfies CellEditorProps);
        }
      }
      return undefined;
    },
    [raw0, identities],
  );
}

export { CellEditor };
