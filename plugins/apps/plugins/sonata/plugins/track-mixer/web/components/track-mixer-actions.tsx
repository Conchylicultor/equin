import { useLibrarySong } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { resetTrackViews } from "../actions";
import { useTrackMixerEntries } from "../hooks";
import { symbol } from "@plugins/ui/plugins/icons/core";

const restartAltIcon = symbol("restart-alt");

/**
 * Header-right action for the "Tracks" `Sonata.Section` (contributed as
 * `actions`). Resets every track's persisted view overrides (color / instrument
 * / mute / hide) back to defaults; disabled when nothing is customized. The host
 * (SectionCard) renders this in the card header, so it stays reachable while the
 * card is collapsed — the reason the reset lives here rather than in the panel
 * body. Renders nothing without a loaded library song, and a loading placeholder while the
 * song's track views are (whether anything is customized is not known yet). No
 * `ControlSizeProvider` here: the SectionCard already renders `actions` at `sm`
 * control density.
 */
export function TrackMixerActions() {
  const song = useLibrarySong();
  const entries = useTrackMixerEntries();
  const fetchEndpoint = useFetchEndpoint();
  if (song.kind === "none") return null;
  if (entries.kind === "pending") return <Loading variant="spinner" />;
  if (entries.kind === "failed")
    return (
      <ResourceErrorInline
        variant="icon"
        icon={restartAltIcon}
        subject="the track views"
        error={entries.error}
        refetch={entries.refetch}
      />
    );
  const anyCustomized = entries.value.some((e) => e.customized);
  return (
    <IconButton
      icon={restartAltIcon}
      label="Reset tracks to defaults"
      disabled={!anyCustomized}
      onClick={() => resetTrackViews(fetchEndpoint, song.songId)}
    />
  );
}
