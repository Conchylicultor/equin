import * as React from "react";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";
import {
  textareaSizeClassFor,
  useControlSize,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size";
import { fieldChromeClass } from "./field-chrome";
import { keptFieldProps, type TextKeepProps } from "./text-keep-props";

// `Input`'s multi-line sibling: the same chrome (field-chrome.ts) and the same
// ambient density for padding and text — only the height is free, growing with
// `rows` and the user's vertical resize. `fitContent` makes it as tall as its
// text (CSS field-sizing), so a long value is never hidden behind a scrollbar.
//
// `keep` is required, as on `Input` (kept-state's `TextKeep`); `bare` drops
// the chrome and density size for a host-styled field.
function Textarea({
  className,
  fitContent = false,
  keep,
  bare = false,
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<"textarea">, "value" | "defaultValue"> &
  DensityControlled &
  TextKeepProps & {
    value?: React.ComponentProps<"textarea">["value"];
    defaultValue?: React.ComponentProps<"textarea">["defaultValue"];
    /** Grow with the text instead of scrolling inside `rows` lines. */
    fitContent?: boolean;
    /** No field chrome, no density size: the host styles the field. */
    bare?: boolean;
  }) {
  const density = useControlSize();
  const field = keptFieldProps<HTMLTextAreaElement>(keep, { value, onChange });
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        !bare && fieldChromeClass,
        !bare && "resize-y",
        fitContent && "field-sizing-content",
        !bare && textareaSizeClassFor(density),
        className,
      )}
      {...props}
      {...field}
    />
  );
}

export { Textarea };
