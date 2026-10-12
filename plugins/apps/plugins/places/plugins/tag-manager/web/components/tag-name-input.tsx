import { useEffect, useRef } from "react";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * A tag's name, edited in place: borderless until hovered or focused, saved
 * on blur or Enter when it changed and is not blank (a blank name reverts),
 * Escape reverts. `autoFocus` focuses and selects it on mount — a tag just
 * made by "+ New tag" / "+ Child", named straight away.
 */
export function TagNameInput({
  name,
  autoFocus,
  onCommit,
}: {
  name: string;
  autoFocus: boolean;
  onCommit: (name: string) => Promise<unknown>;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    ref.current?.select();
  }, [autoFocus]);
  return (
    <Input
      // Keyed by the stored name: a rename arriving from elsewhere resets the
      // uncontrolled field to it.
      key={name}
      ref={ref}
      defaultValue={name}
      aria-label="Tag name"
      className="border-transparent bg-transparent shadow-none hover:border-input focus-visible:bg-background"
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.currentTarget.value = name;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (next === "" || next === name) {
          e.currentTarget.value = name;
          return;
        }
        void onCommit(next);
      }}
    />
  );
}
