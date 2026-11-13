import { createContext, useContext } from "react";
import type { UiContextMeta } from "@plugins/primitives/plugins/ui-context/core";

/**
 * How an element of the draft's page is picked:
 *
 * - `in-page` — the page is THIS document, so the element picker arms its
 *   overlay right here;
 * - `remote` — the page is elsewhere (another browser tab), and `pick()` asks
 *   whoever can reach it for the picked element's metadata.
 */
export type DraftPagePicker =
  { kind: "in-page" } | { kind: "remote"; pick: () => Promise<UiContextMeta> };

/**
 * The page a task draft is about: the screen the agent is told it concerns.
 *
 * - `readUrl` — reads that page's URL; called when the draft opens (the
 *   popover snapshots it) or is filed, never while rendering. `null`: the draft
 *   is about no page (the menu-bar tray), so there is no URL to attach and the
 *   composer offers no Page URL toggle.
 * - `picker` — how an element of that page is picked, or `null` when none can
 *   be: the contributed prose actions that pick (the element picker) render
 *   only when there is one.
 */
export interface DraftPage {
  readUrl: (() => string) | null;
  picker: DraftPagePicker | null;
}

/**
 * The default: the draft is about the page it is drafted on — this document's
 * URL, its elements picked in place. What every surface inside the app gets
 * without saying anything.
 */
const THIS_DOCUMENT: DraftPage = {
  readUrl: () => window.location.href,
  picker: { kind: "in-page" },
};

/** A draft about no page: no URL to attach, nothing to pick. */
export const NO_DRAFT_PAGE: DraftPage = { readUrl: null, picker: null };

const DraftPageContext = createContext<DraftPage>(THIS_DOCUMENT);

/**
 * Declares the page every task draft below is about, for a surface that is not
 * itself that page — a companion about another tab, or about none
 * (`NO_DRAFT_PAGE`).
 */
export const DraftPageProvider = DraftPageContext.Provider;

/** The page the drafts here are about (this document unless a provider says otherwise). */
export function useDraftPage(): DraftPage {
  return useContext(DraftPageContext);
}
