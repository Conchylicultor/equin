import { createContext, useContext } from "react";

/** Closes the help menu — provided by the ? button around its entries. */
export const CloseHelpMenuContext = createContext<(() => void) | null>(null);

/**
 * The help menu's close, for an entry whose action should not leave the menu
 * open over what it starts (a tour, a dialog). Throws outside the menu: an
 * entry rendered anywhere else has no menu to close.
 */
export function useCloseHelpMenu(): () => void {
  const close = useContext(CloseHelpMenuContext);
  if (!close) {
    throw new Error("useCloseHelpMenu: rendered outside the help menu");
  }
  return close;
}
