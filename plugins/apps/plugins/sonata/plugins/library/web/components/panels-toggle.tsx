import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";

/**
 * Whether the player's section dock is folded to its rail — one device-local
 * choice (`useDraft`, so every reader stays in sync within and across tabs),
 * read by the dock itself (`SectionDock`, which paints the rail or the panel)
 * and by the player surface, which gives the notes the room the dock leaves.
 * The key is the one the section column has always persisted under, so an
 * existing choice survives the move.
 */
export function useSectionPaneCollapsed() {
  return useDraft("sonata.section-pane.collapsed", false);
}
