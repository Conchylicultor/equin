import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useMemo } from "react";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  keyAutoDetectSetting,
  useLibrarySong,
  useSongSetting,
  useWriteSongSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { saveKeyAutoDetect } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/key-mode/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { collectKeyEntries } from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * Header-right control for the "Current key" section card: the per-song
 * "Auto-detect key" toggle. Lives in the contribution's `actions` (not the body)
 * so it stays reachable while the card is collapsed. Re-derives `showToggle` from
 * the same score entries the body reads, and renders nothing when the song has no
 * authored key to override. While the song's setting is loading it is a loading
 * placeholder — "off" would be a claim about the song.
 */
export function KeyReadoutActions() {
  const { score } = useSession();
  const song = useLibrarySong();
  const keyAutoDetect = useSongSetting(keyAutoDetectSetting);
  const setKeyAutoDetect = useWriteSongSetting(keyAutoDetectSetting);

  const entries = useMemo(() => collectKeyEntries(score), [score]);

  if (keyAutoDetect.kind === "pending") return <Loading variant="spinner" />;
  if (keyAutoDetect.kind === "failed")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the song's key mode"
        error={keyAutoDetect.error}
        refetch={keyAutoDetect.refetch}
      />
    );
  const autoDetect = keyAutoDetect.value;

  // Show the toggle only for songs that carry an authored key to override — or
  // that already have the override on (in which case the authored key is stripped
  // from `entries`, so OR the live flag).
  const showToggle = entries.some((e) => e.source === "authored") || autoDetect;

  if (!showToggle || song.kind === "none") return null;
  const songId = song.songId;

  const toggleAutoDetect = () => {
    const next = !autoDetect;
    setKeyAutoDetect(songId, next); // optimistic: re-spell/readout update instantly
    saveKeyAutoDetect(songId, next); // persist per song
  };

  return (
    <ToggleChip
      active={autoDetect}
      variant="ghost"
      onClick={toggleAutoDetect}
      tooltip={
        autoDetect
          ? "Using a key auto-detected from the notes. Turn off to use the song's own (MIDI) key."
          : "Using the song's own (MIDI) key. Turn on to auto-detect the key from the notes instead."
      }
    >
      Auto-detect
    </ToggleChip>
  );
}
