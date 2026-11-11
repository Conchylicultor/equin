import type { ColorScheme } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import type React from "react";
import { ColorSchemeProvider } from "./color-scheme";

export interface ColorSchemeRegionProps extends Passthrough {
  /** The scheme the region always wears, whatever the scheme around it. */
  scheme: ColorScheme;
  /** Element or component to render. Default `"div"`. */
  as?: React.ElementType;
  className?: string;
  children?: React.ReactNode;
}

/**
 * A region that always wears one colour scheme, whatever the scheme around it. The image viewer is the case: dark by convention, the photo is the
 * content and the chrome recedes, in whatever scheme the app around it wears.
 *
 * The element is a scheme carrier: its `color-scheme` and `dark:` variants
 * follow it, popups opened from inside are re-stamped with it, and the
 * DESKTOP's base tokens are re-declared on it in `scheme` — so inside an app
 * with a theme of its own, the region wears the desktop's theme in `scheme`,
 * not the app's (as the old `.dark` class did). To wear a whole other theme,
 * use `<Theme>`.
 */
export function ColorSchemeRegion({
  scheme,
  as: Comp = "div",
  className,
  children,
  ref,
  ...rest
}: ColorSchemeRegionProps) {
  return (
    <Comp ref={ref} {...rest} className={className} data-color-scheme={scheme}>
      <ColorSchemeProvider scheme={scheme}>{children}</ColorSchemeProvider>
    </Comp>
  );
}
