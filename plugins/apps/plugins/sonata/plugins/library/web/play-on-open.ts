/**
 * The one-shot "open this song playing" intent: an in-app opener (a library
 * card, a source's create / import, a file preview's Open in Sonata while it
 * was playing) names it just before navigating, and the player surface's loader consumes it when it loads
 * that song — arming play-on-load beside the bar seek. In memory, never in the
 * URL: a reload or a shared link opens a song paused.
 */
let pendingSongId: string | null = null;

export function requestPlayOnOpen(songId: string): void {
  pendingSongId = songId;
}

/** True once, for the song the intent named; any take clears the intent. */
export function takePlayOnOpen(songId: string): boolean {
  const wanted = pendingSongId === songId;
  pendingSongId = null;
  return wanted;
}
