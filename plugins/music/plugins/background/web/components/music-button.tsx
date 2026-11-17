import { useEffect, useState } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { nowPlaying } from "../../shared/protocol";
import { setWarm, useMusicSnapshot } from "../internal/store";
import { BackgroundMusic } from "../slots";
import { Equalizer } from "./equalizer";
import { MusicPanel } from "./music-panel";

const musicIcon = symbol("music-note");

/**
 * The global action bar's music button: a note while nothing plays, moving
 * bars while music plays (here, or in another browser tab). It opens the
 * background music panel; while the panel is open, every source's player
 * is mounted idle so a click on a source only resumes audio.
 */
export function MusicButton() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setWarm(open);
    return () => setWarm(false);
  }, [open]);
  const { state, titles } = useMusicSnapshot();
  const sources = BackgroundMusic.Source.useContributions();
  const now = nowPlaying(state);
  const playing = now?.playing ?? false;
  const source = now ? sources.find((s) => s.id === now.sourceId) : undefined;
  const title =
    now?.where === "remote"
      ? now.title
      : now
        ? titles.get(now.sourceId)
        : undefined;
  const label =
    playing && source
      ? `${title ?? source.kind} — ${source.app.name}`
      : "Background music";

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      side="bottom"
      label="Background music"
      trigger={
        playing ? (
          <Button
            variant={open ? "secondary" : "ghost"}
            aspect="icon"
            aria-label={label}
            tooltip={label}
          >
            <Equalizer on />
          </Button>
        ) : (
          <IconButton
            icon={musicIcon}
            label={label}
            variant={open ? "secondary" : "ghost"}
          />
        )
      }
    >
      <MusicPanel onLeave={() => setOpen(false)} />
    </ControlPanelPopover>
  );
}
