import { useMemo } from "react";
import { scoreEndBeat } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { usePlayerView } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { toggleLoop } from "../loop-actions";

/**
 * Headless A–B-loop keyboard registrar (a `Sonata.Effect`, mirroring controls'
 * `TransportShortcuts`): surface-scoped, focus-gated shortcuts that fire only
 * while THIS Sonata surface is focused, and only while the player is on screen
 * (`shown`) so they stay inert on the library — even while a song plays there
 * in the background.
 *
 *  - `L` — toggle the loop (create the whole-song region, or flip enabled).
 *  - `[` — set the loop start (A) at the playhead, enabling the loop.
 *  - `]` — set the loop end (B) at the playhead, enabling the loop.
 *
 * `[`/`]` go through `setLoop`, whose clamp + min-gap protect against inversion
 * (e.g. setting A past B). It lives in the loop plugin (not controls) so the
 * whole feature stays atomic.
 */
export function LoopShortcuts() {
  const { shown } = usePlayerView();
  const { loop, setLoop, score } = useSession();
  const cursor = useCursorApi();

  const descriptors = useMemo(
    () =>
      !shown
        ? []
        : [
            {
              id: "sonata.loop-toggle",
              keys: "l",
              label: "Toggle loop",
              group: "Sonata",
              handler: () => toggleLoop({ loop, setLoop, score }),
            },
            {
              id: "sonata.loop-start",
              keys: "[",
              label: "Set loop start",
              group: "Sonata",
              handler: () =>
                setLoop({
                  start: cursor.getBeat(),
                  // Default B to the song end (not the playhead) so a lone `[`
                  // gives a usable A→end range instead of collapsing to the
                  // min-gap; a later `]` then trims B to the passage's end.
                  end: loop?.end ?? scoreEndBeat(score),
                  enabled: true,
                }),
            },
            {
              id: "sonata.loop-end",
              keys: "]",
              label: "Set loop end",
              group: "Sonata",
              handler: () =>
                // Default A to the song start so a lone `]` gives a usable
                // start→B range (symmetric with `[`).
                setLoop({
                  start: loop?.start ?? 0,
                  end: cursor.getBeat(),
                  enabled: true,
                }),
            },
          ],
    [shown, loop, setLoop, score, cursor],
  );

  useSurfaceShortcuts(descriptors);
  return null;
}
