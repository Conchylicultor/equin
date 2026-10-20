import { useMemo } from "react";
import {
  TEMPO_MATH_FLOOR,
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  buildTempoIndex,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { formatElapsed } from "@plugins/primitives/plugins/relative-time/web";
import { SonataPlayer } from "../slots";
import { useMarkPlayerShown, usePlayerView } from "../view";
import { NoDisplay } from "./no-display";
import { DisplayCoverContext, NO_COVER, type DisplayCover } from "../cover";

/**
 * The display lens over the session's score — `displayId`, else the player
 * view's lens — dispatched through `SonataPlayer.Display` inside a `Clip` that
 * fills its parent. Renders the no-display fallback when no lens is
 * contributed. While mounted it marks the player shown, which mounts the
 * player's `SonataPlayer.Effect`s (the keyboard transport).
 *
 * `cover` is what the host's floating chrome covers. A `bleed` display fills
 * the whole box and reads the cover (`useDisplayCover`) to keep its content
 * out of it while its ground runs under the chrome; any other display is laid
 * out beside the cover.
 */
export function PlayerDisplay({
  displayId,
  cover = NO_COVER,
}: {
  displayId?: string;
  cover?: DisplayCover;
}) {
  useMarkPlayerShown();
  const { score, tempoScale } = useSession();
  const view = usePlayerView();
  const displays = SonataPlayer.Display.useContributions();
  const active = displayId ?? view.displayId;
  const bleed = displays.find((d) => d.id === active)?.bleed === true;
  return (
    <Clip fill className="relative">
      <Placed x={{ start: 0, end: bleed ? 0 : cover.right }} y="fill">
        {active === null ? (
          <NoDisplay />
        ) : (
          <DisplayCoverContext.Provider value={bleed ? cover : NO_COVER}>
            <SonataPlayer.Display.Dispatch
              score={score}
              // Displays scale geometry by this to cancel the scale folded into
              // `score`; floor it so a frozen 0% (which scales `score` by the
              // same floor) cancels to a finite layout instead of NaN.
              tempoScale={Math.max(tempoScale, TEMPO_MATH_FLOOR)}
              activeDisplayId={active}
            />
          </DisplayCoverContext.Provider>
        )}
      </Placed>
    </Clip>
  );
}

/**
 * The transport strip — one row holding every `SonataPlayer.Transport`
 * contribution (play / pause, the progress scrubber with its markers, the loop
 * toggle), in the order the slot's reorder config gives. The strip owns the
 * row: its inset, its rhythm and the alignment. A contribution that should
 * take the row's slack (the scrubber) declares `fill` on itself. Renders
 * nothing with no contributor.
 *
 * Two ways to sit in a host: `strip` (default) — a full-width band closed by a
 * rule, under a header; `capsule` — the inside of a floating pill (the
 * immersive player's progression bar), hugging the round play button.
 */
export function PlayerTransport({
  variant = "strip",
}: {
  variant?: "strip" | "capsule";
} = {}) {
  const items = SonataPlayer.Transport.useContributions();
  if (items.length === 0) return null;
  return (
    <Stack
      direction="row"
      align="center"
      gap={variant === "capsule" ? "sm" : "md"}
      className={
        variant === "capsule"
          ? "py-xs pr-sm pl-xs"
          : "border-b border-border px-xl py-md"
      }
    >
      <SonataPlayer.Transport.Render>
        {(t) => <t.component key={t.id} />}
      </SonataPlayer.Transport.Render>
    </Stack>
  );
}

/**
 * The playhead's time and the song's duration (`m:ss / m:ss`), in real
 * seconds at the current tempo — the session's score has the tempo scale
 * folded in, so at 50% speed both stretch to match. Re-renders once per
 * second of playback, never per frame; the lead-in pre-roll reads `0:00`.
 */
export function PlayerTime() {
  const { score } = useSession();
  const tempo = useMemo(() => buildTempoIndex(score), [score]);
  const endBeat = scoreEndBeat(score);
  const elapsedSec = useCursorSelector(
    (beat) => Math.max(0, Math.floor(tempo.beatToSeconds(beat))),
    [tempo],
  );
  const totalSec = endBeat > 0 ? tempo.beatToSeconds(endBeat) : 0;
  return (
    <Text variant="caption" tone="muted" className="tabular-nums">
      {formatElapsed(elapsedSec * 1000)} / {formatElapsed(totalSec * 1000)}
    </Text>
  );
}
