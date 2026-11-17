import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import {
  fieldSizeClassFor,
  useControlSize,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size";
import { fieldChromeClass } from "./field-chrome";
import { keptFieldProps, type TextKeepProps } from "./text-keep-props";

// Height, inline padding, gap and text size come from the ambient control
// density (`fieldSizeClassFor`), exactly like `Button` — never a per-instance
// `size` or height class, so a field always matches the buttons beside it.
// `keep` is required: every text field decides whether what is typed in it
// survives a reload and a tab switch (kept-state's `TextKeep`) — a `useKept`
// binding, or `transient("<why>")`. `bare` drops the field chrome and the
// density size (an inline field styled by its host: a title, a cell) — the
// keep decision stays.
function Input({
  className,
  type,
  outline = "solid",
  keep,
  bare = false,
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<"input">, "size" | "value" | "defaultValue"> &
  DensityControlled &
  TextKeepProps & {
    value?: React.ComponentProps<"input">["value"];
    defaultValue?: React.ComponentProps<"input">["defaultValue"];
    /** No field chrome, no density size: the host styles the field. */
    bare?: boolean;
    /**
     * The field's hairline. `dashed` is the OPTIONAL field — "add one more"
     * (a folder, a tag) beside a list of the real ones — the twin of
     * `Button variant="dashed"`; it turns solid while focused, once it is
     * being filled in.
     */
    outline?: "solid" | "dashed";
    /** Draw the field through another input element that owns its own state
     * (a headless library's search input), keeping this field's chrome. */
    render?: React.ReactElement;
  }) {
  const density = useControlSize();
  const field = keptFieldProps<HTMLInputElement>(keep, { value, onChange });
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        !bare && fieldChromeClass,
        !bare &&
          "file:inline-flex file:h-full file:border-0 file:bg-transparent file:text-label file:text-foreground",
        !bare && fieldSizeClassFor(density),
        !bare && outline === "dashed" && "border-dashed focus:border-solid",
        className,
      )}
      {...props}
      {...field}
    />
  );
}

export { Input };
