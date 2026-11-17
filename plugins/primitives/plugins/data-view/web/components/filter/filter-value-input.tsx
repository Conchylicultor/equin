import type { ComponentProps, ReactNode } from "react";
import {
  Input,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";

/**
 * The text/number operand input shared by every field type's filter value
 * editor. A plain ui-kit `Input`: its height, padding and text follow the
 * ambient control density, so the value cell lines up with the field/operator
 * picker buttons in the same rule row by construction. Centralizing it here
 * means every field type's filter input shares one chrome instead of each
 * hand-rolling a raw `<input>` with ad-hoc width/padding.
 *
 * Its text is transient: every caller hands the operand to the rule's
 * `onChange` on each keystroke, so the view's filter already holds it.
 */
export function FilterValueInput(
  props: Omit<ComponentProps<"input">, "size"> & DensityControlled,
): ReactNode {
  return (
    <Input
      keep={transient("committed on every change: the filter rule holds it")}
      {...props}
    />
  );
}
