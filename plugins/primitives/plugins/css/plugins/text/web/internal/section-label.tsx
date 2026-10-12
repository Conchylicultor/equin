import {
  cn,
  MENU_LABEL_PAINT,
  useMenuSurface,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "./text";

export interface SectionLabelProps extends React.HTMLAttributes<HTMLElement> {
  as?: React.ElementType;
}

/**
 * The label that names a section — and it reads WHERE it is to decide how.
 *
 * - On a page: the eyebrow / form-section / content-header label — the small-caps
 *   muted label (`<Text variant="eyebrow" tone="muted">`).
 * - Inside a menu surface (`useMenuSurface()` — a dropdown, select, popover or
 *   control panel): the shared menu section label (ui-kit `MENU_LABEL_PAINT`:
 *   faint caption, semibold, sentence case), the one a `DropdownMenuSection`,
 *   `ControlPanel.Section` or `ControlPanel.Subhead` draws. A heading placed
 *   inside a menu therefore cannot drift from the menu's own headings.
 */
export function SectionLabel({
  as = "div",
  className,
  children,
  ...rest
}: SectionLabelProps) {
  const inMenu = useMenuSurface();
  if (inMenu) {
    return (
      <Text
        variant="caption"
        as={as}
        className={cn(MENU_LABEL_PAINT, className)}
        {...rest}
      >
        {children}
      </Text>
    );
  }
  return (
    <Text
      variant="eyebrow"
      tone="muted"
      as={as}
      className={className}
      {...rest}
    >
      {children}
    </Text>
  );
}
