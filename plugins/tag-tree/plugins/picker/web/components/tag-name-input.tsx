import { useEffect, useRef } from "react";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * A tag's name typed in place (a rename, or a new tag's draft row): focused
 * and selected on mount; Enter or blur commits the trimmed text, Escape
 * commits `initial` (a revert — for a draft, the blank that discards it). The
 * caller decides what blank or unchanged means. The row's own gestures (pick,
 * drag, open) never see the input's clicks and keys.
 */
export function TagNameInput({
  initial,
  placeholder,
  onCommit,
}: {
  initial: string;
  placeholder: string;
  onCommit(name: string): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (name: string) => {
    if (done.current) return;
    done.current = true;
    onCommit(name.trim());
  };
  return (
    <Input
      ref={ref}
      defaultValue={initial}
      placeholder={placeholder}
      aria-label={placeholder}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.currentTarget.value);
        if (e.key === "Escape") {
          e.preventDefault();
          commit(initial);
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}
