import { useMemo } from "react";
import { useSurfaceShortcuts } from "./use-surface-shortcut";

/**
 * Whether Space landed inside a native media element: its own controls toggle
 * playback themselves, so a second toggle here would undo it.
 */
function nativeMediaClaims(event: KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof Element && target.closest("video, audio") !== null;
}

/**
 * Space plays / pauses the player shown on this surface — the one binding
 * every player (a file preview's video, Sonata) shares, so they agree on when
 * the key is theirs.
 *
 * Surface-scoped (`useSurfaceShortcuts`): `toggle` drives only this surface's
 * player. Space yields to a text field (`targetClaimsKey`), to an element that
 * already handled it, and to a native media element's own controls — but NOT
 * to a button merely left focused: the link that opened the player keeps focus,
 * and Space must still pause what it opened. Pass `toggle: null` while there is
 * nothing to play yet.
 */
export function usePlayPauseShortcut(toggle: (() => void) | null): void {
  const descriptors = useMemo(
    () =>
      toggle === null
        ? []
        : [
            {
              id: "playback.play-pause",
              keys: "space",
              label: "Play / pause",
              group: "Playback",
              when: (e: KeyboardEvent) => !nativeMediaClaims(e),
              handler: toggle,
            },
          ],
    [toggle],
  );
  useSurfaceShortcuts(descriptors);
}
