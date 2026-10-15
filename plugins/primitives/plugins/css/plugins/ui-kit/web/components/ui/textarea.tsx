import * as React from "react";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import {
  textareaSizeClassFor,
  useControlSize,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size";
import { fieldChromeClass } from "./field-chrome";

// `Input`'s multi-line sibling: the same chrome (field-chrome.ts) and the same
// ambient density for padding and text — only the height is free, growing with
// `rows` and the user's vertical resize. `fitContent` makes it as tall as its
// text (CSS field-sizing), so a long value is never hidden behind a scrollbar.
function Textarea({
  className,
  fitContent = false,
  ...props
}: React.ComponentProps<"textarea"> &
  DensityControlled & {
    /** Grow with the text instead of scrolling inside `rows` lines. */
    fitContent?: boolean;
  }) {
  const density = useControlSize();
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        fieldChromeClass,
        "resize-y",
        fitContent && "field-sizing-content",
        textareaSizeClassFor(density),
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
