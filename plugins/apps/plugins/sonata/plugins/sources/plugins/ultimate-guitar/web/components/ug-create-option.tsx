import type { SourceCreateOption } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { UgImportDialog } from "./ug-import-dialog";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const musicNoteIcon = symbol("music-note");

/**
 * The UG source's create affordance, contributed to `Library.Source` and mapped
 * by the library into the data-view `creators` "+" menu. Unlike chord-grid (a
 * static starter) or MIDI (a native file picker), UG needs a tab URL up front,
 * so `onSelect` opens the import dialog via the imperative-dialog primitive. The
 * dialog owns fetch → compile → create → open; awaiting its close keeps the "+"
 * control busy while it's open. Fetch-first means the library never gains a
 * half-formed "Untitled" song when the user cancels. Fully imperative — no hooks.
 */
export const ultimateGuitarCreateOption: SourceCreateOption = {
  id: "ultimate-guitar",
  label: "Import from Ultimate Guitar",
  description: "Paste a tab URL to import chords, sections, and lyrics.",
  icon: <Icon icon={musicNoteIcon} className="size-4" />,
  onSelect: ({ openDialog }) =>
    openDialog((close) => <UgImportDialog onClose={close} />, { size: "md" }),
};
