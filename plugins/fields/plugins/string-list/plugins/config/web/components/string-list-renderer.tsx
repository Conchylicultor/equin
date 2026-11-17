import { defineFieldShape } from "@plugins/config_v2/plugins/fields/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { stringListFieldType } from "@plugins/fields/plugins/string-list/core";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState } from "react";

/**
 * A list of scalars: one `list` whose items are `value` shapes. It stopped being
 * its own layout — the sortable card, the drag handle, the remove button and the
 * "Add item" button all left, because a list of records and a list of strings
 * are now the same arm.
 */
const StringListRenderer = defineFieldShape({
  type: stringListFieldType,
  useShape: ({ field, value, onChange }) => {
    // The stored value is a bare `string[]` whose entries can duplicate and
    // mutate freely, so a string cannot be its own id. We keep a parallel id
    // array, positionally aligned to `value`, and reconcile it whenever
    // `value`'s length changes underneath us (external edit, reset). A row then
    // keeps its identity across a typing session even as its text changes.
    const [ids, setIds] = useState<string[]>(() =>
      Array.from({ length: value.length }, () => crypto.randomUUID()),
    );
    if (ids.length !== value.length) {
      const next = ids.slice(0, value.length);
      while (next.length < value.length) next.push(crypto.randomUUID());
      setIds(next);
    }

    const indexOf = (id: string) => ids.indexOf(id);

    return {
      kind: "list",
      addLabel: "Add item",
      items: value.map((entry, index) => ({
        id: ids[index] ?? String(index),
        shape: {
          kind: "value",
          fit: "field",
          control: (
            <StringItemInput
              value={entry}
              placeholder={field.meta.placeholder}
              onCommit={(next) => {
                if (value[index] === next) return;
                onChange(value.map((v, i) => (i === index ? next : v)));
              }}
            />
          ),
        },
      })),
      onAdd: () => {
        setIds([...ids, crypto.randomUUID()]);
        onChange([...value, ""]);
      },
      onRemove: (id) => {
        const index = indexOf(id);
        if (index < 0) return;
        setIds(ids.filter((_, i) => i !== index));
        onChange(value.filter((_, i) => i !== index));
      },
      onMove: (activeId, overId) => {
        const from = indexOf(activeId);
        const to = indexOf(overId);
        if (from < 0 || to < 0 || from === to) return;
        const nextIds = [...ids];
        const [movedId] = nextIds.splice(from, 1);
        nextIds.splice(to, 0, movedId!);
        const nextValue = [...value];
        const [movedVal] = nextValue.splice(from, 1);
        nextValue.splice(to, 0, movedVal!);
        setIds(nextIds);
        onChange(nextValue);
      },
    };
  },
});

/**
 * One row's input, as a COMPONENT because the edit buffer is per row and a
 * shape hook has no per-item hook to spend. Typing updates `local`; the flush is
 * on blur, so a controlled re-render mid-keystroke cannot fight the cursor.
 * While unfocused the row mirrors the external value (a reorder, an external
 * edit).
 */
function StringItemInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);
  if (!focused && local !== value) setLocal(value);
  return (
    <Input
      keep={transient(
        "committed on blur; a row's id is minted per mount, so there is no stable subject to keep it under",
      )}
      value={local}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        setFocused(false);
        onCommit(local);
      }}
    />
  );
}

export { StringListRenderer };
