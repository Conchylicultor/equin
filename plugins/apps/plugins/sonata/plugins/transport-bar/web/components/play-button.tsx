import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { scoreEndBeat } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";

/** The disc's lift at rest, and its accent ring while playing. */
const RESTING_SHADOW = "0 8px 24px rgb(0 0 0 / 0.4)";
const PLAYING_GLOW =
  "0 0 0 6px color-mix(in oklab, var(--primary) 22%, transparent), 0 0 30px color-mix(in oklab, var(--primary) 45%, transparent)";

const pauseIcon = symbol("pause");
const playArrowIcon = symbol("play-arrow");

/**
 * Play / pause at the head of the player's transport strip
 * (`SonataPlayer.Transport`). It drives the shared transport's `togglePlay` —
 * the deliberate-play path, with the metronome's count-in lead-in — the same
 * verb as the Space key, so button and keyboard always agree.
 *
 * A pending count-in reads as playing: the button shows Pause and a click
 * cancels the lead-in (`togglePlay` stops it). Nothing to play until a source
 * has loaded a score with span, and a frozen 0% speed cannot play either.
 */
export function PlayButton() {
  const { isPlaying, countIn, togglePlay, tempoScale, score } = useSession();
  const active = isPlaying || countIn !== null;
  const canPlay = scoreEndBeat(score) > 0 && tempoScale > 0;
  return (
    // The transport's one big control: a round, text-coloured disc lifted off
    // the bar, the stage's ink for its glyph; while playing it wears a soft
    // ring of the accent. The disc is the button's backdrop — the button keeps
    // the toolbar's own density inside it.
    <Center
      className={cn(
        "size-12 rounded-full bg-foreground text-background transition-[transform,box-shadow] duration-300 hover:scale-105 active:scale-95",
        rigidClass(),
      )}
      style={{ boxShadow: active ? PLAYING_GLOW : RESTING_SHADOW }}
    >
      <IconButton
        icon={active ? pauseIcon : playArrowIcon}
        active
        label={active ? "Pause" : "Play"}
        shortcut="space"
        disabled={!active && !canPlay}
        onClick={togglePlay}
        className="rounded-full hover:bg-transparent hover:text-background"
      />
    </Center>
  );
}
