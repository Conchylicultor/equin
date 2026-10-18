import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";

/** The desktop backdrop's measured size (px), or null before it is laid out. */
type DeskBoundsReader = () => { width: number; height: number } | null;

const deskBoundsSink = defineInstallSink<DeskBoundsReader>({
  name: "desktop.desk-bounds",
  what: "the desktop backdrop's size reader (installed by the windows' Foreground)",
});

/**
 * Install the reader of the backdrop's size; returns the disposer. The
 * Foreground's full-bleed frame installs it, so the imperative commands
 * (overview, tile all) can lay windows out without a DOM handle of their own.
 */
export function setDeskBoundsReader(next: DeskBoundsReader): () => void {
  return deskBoundsSink.install(next);
}

/** One-shot read of the backdrop's size — commands only, never a render. */
export function peekDeskBounds(): { width: number; height: number } | null {
  return deskBoundsSink.peek()?.() ?? null;
}
