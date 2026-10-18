import { useCallback, type ReactNode } from "react";
import {
  useCompanionLookup,
  useRawContributions,
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
  // A companion here ships only in bundles that use its field type (see
  // `KeySpace`): the data-view primitive plus a plugin referencing the type.
  companions: { key: "match", space: "field-type" },
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
  const lookup = useCompanionLookup(
    CellEditor,
    useRawContributions(CellEditor),
  );
  return useCallback(
    ({ field, value, values, raw, onCommit, onCommitValues, onCancel }) => {
      const contribution = lookup(
        resolveTypeChain(field.type ?? "text", identities),
      );
      if (!contribution) return undefined;
      return renderIsolated(CellEditor, contribution, {
        value,
        values,
        field,
        raw,
        onCommit,
        onCommitValues,
        onCancel,
      } satisfies CellEditorProps);
    },
    [lookup, identities],
  );
}

export { CellEditor };
