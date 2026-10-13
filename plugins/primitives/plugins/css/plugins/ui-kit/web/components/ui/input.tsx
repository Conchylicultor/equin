import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import {
  fieldSizeClassFor,
  useControlSize,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size";
import { fieldChromeClass } from "./field-chrome";

// Height, inline padding, gap and text size come from the ambient control
// density (`fieldSizeClassFor`), exactly like `Button` — never a per-instance
// `size` or height class, so a field always matches the buttons beside it.
function Input({
  className,
  type,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  DensityControlled & {
    /** Draw the field through another input element that owns its own state
     * (a headless library's search input), keeping this field's chrome. */
    render?: React.ReactElement;
  }) {
  const density = useControlSize();
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        fieldChromeClass,
        "file:inline-flex file:h-full file:border-0 file:bg-transparent file:text-label file:text-foreground",
        fieldSizeClassFor(density),
        className,
      )}
      {...props}
    />
  );
}

export { Input };
