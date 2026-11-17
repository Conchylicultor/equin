import { useState, type ReactElement } from "react";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";

/**
 * A text input that writes once the person is done — on blur or Enter — not
 * on every keystroke, so a half-typed cron or time is never saved. Shows the
 * stored value again whenever it changes from elsewhere.
 */
export function CommitInput({
  value,
  onCommit,
  ariaLabel,
  type = "text",
  className,
}: {
  value: string;
  onCommit: (value: string) => void;
  ariaLabel: string;
  type?: "text" | "time" | "number";
  className?: string;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    // The stored value moved (our own write landing, or another tab's): adopt it.
    setShown(value);
    setDraft(value);
  }
  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      type={type}
      keep={transient(
        "committed on blur or Enter: a short cron, time or number",
      )}
      value={draft}
      aria-label={ariaLabel}
      className={className}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
