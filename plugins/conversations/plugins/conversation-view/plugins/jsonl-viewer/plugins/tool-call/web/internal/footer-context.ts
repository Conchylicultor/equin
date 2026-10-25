import { createContext, type ReactNode } from "react";

/**
 * The `JsonlViewerTool.Footer` contributions `ToolCallRow` rendered for one
 * call, handed down to the `ToolCallCard` the call's renderer draws, which
 * puts them inside its chrome — so what a call left behind (its browser
 * screenshot) reads as part of the call, not as a loose row under it.
 * Keyed by the call: a card drawn for another call inside this one's renderer
 * (a nested transcript) does not take it.
 */
export const ToolFooterContext = createContext<
  { toolUseId: string; footer: ReactNode } | undefined
>(undefined);
