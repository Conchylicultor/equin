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
 *
 * `when` narrows it further, for a player that knows more about where the key
 * landed: a player drawing its own controls yields Space to a focused button
 * of its own (that button activates on Space itself, so toggling here too
 * would act twice), and with several players on one surface each takes only
 * the keys meant for it.
 */
export function usePlayPauseShortcut(
  toggle: (() => void) | null,
  when?: (event: KeyboardEvent) => boolean,
): void {
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
              when: (e: KeyboardEvent) =>
                !nativeMediaClaims(e) && (when === undefined || when(e)),
              handler: toggle,
            },
          ],
    [toggle, when],
  );
  useSurfaceShortcuts(descriptors);
}
