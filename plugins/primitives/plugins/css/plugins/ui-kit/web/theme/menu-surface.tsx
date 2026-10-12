import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether the surrounding region is a **menu surface** — a dropdown, a select,
 * a popover, a control panel. The ambient twin of `SingleLine`, for headings.
 *
 * A section heading's look is not a property of the heading: the same
 * `<SectionLabel>` is an uppercase eyebrow on a page and the shared menu label
 * (`MENU_LABEL_PAINT`: faint caption, semibold, sentence case) inside a menu.
 * It is a property of WHERE the heading lives, owned by the container — so a
 * picker, a header or a contributed block dropped into a menu can no longer
 * draw a heading the menu's own `Section` labels don't (the icon picker's
 * "ICON" under a panel's "Color" was that drift).
 *
 * - **Menu surfaces** (`DropdownMenuContent` and its sub-menus, `SelectContent`,
 *   `PopoverContent`, `ControlPanel`) provide `true`.
 * - **Page-level overlays** (`DialogContent`, `SheetContent`) RESET to `false`:
 *   React context crosses portals, so a dialog opened from a menu item would
 *   otherwise inherit the menu's headings.
 *
 * Lives in ui-kit beside `single-line.tsx` so the `Text` leaf reads it without
 * inverting layers.
 */
const MenuSurfaceContext = createContext<boolean>(false);

/** Declares whether everything inside is a menu surface (innermost wins). A bare Provider. */
export function MenuSurfaceProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}) {
  return (
    <MenuSurfaceContext.Provider value={value}>
      {children}
    </MenuSurfaceContext.Provider>
  );
}

/** Reads the ambient menu-surface contract. Defaults to `false` (page) outside any provider. */
export function useMenuSurface(): boolean {
  return useContext(MenuSurfaceContext);
}
