import type * as React from "react";
import {
  resolveTextKeep,
  type KeptBinding,
  type KeptText,
  type TextKeep,
  type Transient,
} from "@plugins/primitives/plugins/kept-state/core";

/**
 * The required `keep` prop of `Input` / `Textarea` (kept-state's `TextKeep`):
 * whether what the user types here survives a reload and a tab switch.
 *
 * - kept (`useKept` / `useDraft` binding, or a field that keeps its own text
 *   such as `useEditableField`'s result): the binding IS the value — there is
 *   no `value` / `defaultValue` to pass; `onChange` still runs, after it.
 * - `transient("<why>")`: throwaway by design — the field takes its caller's
 *   `value` / `onChange` / `defaultValue` as a plain input does.
 */
export type TextKeepProps =
  | {
      keep: KeptBinding<string> | KeptText;
      value?: never;
      defaultValue?: never;
    }
  | { keep: Transient };

type ChangeEl = HTMLInputElement | HTMLTextAreaElement;

/**
 * The `value` / `onChange` a field renders with: from its `keep` when kept
 * (the caller's `onChange` chained after the binding's setter), else the
 * caller's own.
 */
export function keptFieldProps<E extends ChangeEl>(
  keep: TextKeep,
  props: {
    value?: React.InputHTMLAttributes<E>["value"];
    onChange?: React.ChangeEventHandler<E>;
  },
): {
  value?: React.InputHTMLAttributes<E>["value"];
  onChange?: React.ChangeEventHandler<E>;
} {
  const kept = resolveTextKeep(keep);
  if (kept === null) return { value: props.value, onChange: props.onChange };
  const callerChange = props.onChange;
  return {
    value: kept.value,
    onChange: (event) => {
      kept.set(event.currentTarget.value);
      callerChange?.(event);
    },
  };
}
