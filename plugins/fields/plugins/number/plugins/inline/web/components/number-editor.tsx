import { useRef, useState, type ReactNode } from "react";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { CellEditorProps } from "@plugins/primitives/plugins/data-view/web";

/** Compact inline numeric editor: commits on Enter/blur, cancels on Esc. */
export function NumberEditor(props: CellEditorProps): ReactNode {
  const [local, setLocal] = useState(
    props.value == null ? "" : String(props.value),
  );
  const committed = useRef(false);

  function commit() {
    if (committed.current) return;
    committed.current = true;
    const t = local.trim();
    if (t === "") {
      props.onCommit(null);
    } else {
      const n = Number(t);
      if (Number.isNaN(n)) props.onCancel();
      else props.onCommit(n);
    }
  }

  return (
    <Input
      type="number"
      autoFocus
      className="tabular-nums"
      keep={transient("a one-shot cell editor committed on blur / Enter")}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed.current = true;
          props.onCancel();
        }
      }}
    />
  );
}
