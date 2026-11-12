import { useMemo, type ReactNode } from "react";
import {
  FileExpandAction,
  type FileRendererProps,
} from "@plugins/primitives/plugins/file-viewer/web";
import {
  locationKey,
  locationName,
  type FileLocation,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import {
  fileBytesUnavailableMessage,
  useFileBytes,
} from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import { SonataMiniPlayer } from "@plugins/apps/plugins/sonata/plugins/mini-player/web";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { barPositionAt } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  requestPlayOnOpen,
  sonataSongLink,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import {
  MIDI_SOURCE_ID,
  deriveMidiSongMeta,
  importMidiBytes,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/web";
import { useAppLink } from "@plugins/apps-core/plugins/tabs/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { showToast } from "@plugins/shell/plugins/toast/web";

/**
 * The file viewer's MIDI renderer: the file in Sonata's mini player — the
 * notes falling onto the keyboard, the progression capsule over them — and
 * Open in Sonata at the playhead as the renderer's Expand (the host draws it). Reads the file's
 * bytes (loading / unavailable / error are shown as such), parses them once —
 * a file that is not MIDI is an error state, never an empty roll — and only
 * then mounts a player.
 */
export function MidiFilePreview({ file }: FileRendererProps): ReactNode {
  const state = useFileBytes(file);
  switch (state.kind) {
    case "loading":
      return <Loading />;
    case "unavailable":
      return (
        <Placeholder tone="error">
          {fileBytesUnavailableMessage(state)}
        </Placeholder>
      );
    case "error":
      return (
        <Placeholder tone="error">
          {state.message || "Failed to read the file."}
        </Placeholder>
      );
    case "ok":
      return <ParsedPreview file={file} bytes={state.bytes} />;
  }
}

function ParsedPreview({
  file,
  bytes,
}: {
  file: FileLocation;
  bytes: ArrayBuffer;
}) {
  const name = locationName(file);
  const error = useMemo(() => {
    try {
      deriveMidiSongMeta(bytes, name);
      return null;
    } catch (err) {
      // A malformed file is the file's answer, shown as such — the document
      // would otherwise throw the same parse error mid-render.
      return err instanceof Error ? err.message : String(err);
    }
  }, [bytes, name]);
  const key = locationKey(file);
  // A file document: no library song, so no persisted settings — every
  // setting reads its default and nothing can be written for it.
  const identity = useMemo(() => ({ kind: "file" as const, key }), [key]);
  const rawById = useMemo(() => ({ [MIDI_SOURCE_ID]: bytes }), [bytes]);
  if (error !== null) {
    return (
      <Placeholder tone="error">Not a readable MIDI file: {error}</Placeholder>
    );
  }
  return (
    <SonataMiniPlayer identity={identity} rawById={rawById}>
      <OpenInSonata file={file} bytes={bytes} />
    </SonataMiniPlayer>
  );
}

/**
 * The renderer's Expand: put the file in the Sonata library (idempotent by
 * content) and open it in Sonata at the preview's playhead bar (the URL
 * carries it; the label does not). Drawn by the host (its pane's Expand, or a
 * header button) but declared in the preview's player, so it reads where that
 * player is.
 */
function OpenInSonata({
  file,
  bytes,
}: {
  file: FileLocation;
  bytes: ArrayBuffer;
}) {
  const appLink = useAppLink();
  const { score, stop, isPlaying } = useSession();
  const cursor = useCursorApi();
  const fetchEndpoint = useFetchEndpoint();
  const resolve = async () => {
    // Opening continues what the preview was doing: playing → Sonata plays.
    const wasPlaying = isPlaying;
    stop();
    // Anywhere in the first bar (or its lead-in) is "the start": no bar.
    const at = barPositionAt(score, cursor.getBeat()).bar;
    const bar = at > 1 ? at : undefined;
    try {
      const song = await importMidiBytes(
        fetchEndpoint,
        bytes,
        locationName(file),
      );
      if (wasPlaying) requestPlayOnOpen(song.id);
      return appLink(sonataSongLink(song.id, bar));
    } catch (err) {
      showToast({
        title: "Could not open in Sonata",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
      throw err;
    }
  };
  return <FileExpandAction label="Open in Sonata" resolve={resolve} />;
}
