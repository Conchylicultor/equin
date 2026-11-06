import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  fileBytesUnavailableMessage,
  useFileBytes,
  type FileRendererProps,
} from "@plugins/primitives/plugins/file-viewer/web";
import {
  fileRefKey,
  fileRefName,
  type FileRef,
} from "@plugins/primitives/plugins/file-viewer/core";
import {
  PlayerDisplay,
  PlayerTransport,
  SonataPlayerScope,
  usePlayerView,
} from "@plugins/apps/plugins/sonata/plugins/player/web";
import {
  useLoadDocument,
  useSongDocument,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  useCursorApi,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  barPositionAt,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { sonataSongLink } from "@plugins/apps/plugins/sonata/plugins/library/web";
import {
  MIDI_SOURCE_ID,
  deriveMidiSongMeta,
  importMidiBytes,
  type MidiSongMeta,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/web";
import { useNavigate } from "@plugins/apps-core/plugins/tabs/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { formatElapsed } from "@plugins/primitives/plugins/relative-time/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { midiFacts } from "../facts";

const musicIcon = symbol("music-note");
const pianoIcon = symbol("piano");

/**
 * The file viewer's MIDI renderer: what the file holds at a glance, Sonata's
 * own falling-notes piano roll over it with a play bar, and Open in Sonata at
 * the playhead. Reads the file's bytes (loading / unavailable / error are
 * shown as such), parses them once — a file that is not MIDI is an error
 * state, never an empty roll — and only then mounts a player.
 */
export function MidiFilePreview({ file }: FileRendererProps): ReactNode {
  const state = useFileBytes(file);
  switch (state.kind) {
    case "loading":
      return <Loading />;
    case "unavailable":
      return (
        <Placeholder tone="error">
          {fileBytesUnavailableMessage(state.reason)}
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

type Parsed =
  { kind: "ok"; meta: MidiSongMeta } | { kind: "error"; message: string };

function ParsedPreview({ file, bytes }: { file: FileRef; bytes: ArrayBuffer }) {
  const name = fileRefName(file);
  const parsed = useMemo<Parsed>(() => {
    try {
      return { kind: "ok", meta: deriveMidiSongMeta(bytes, name) };
    } catch (err) {
      // A malformed file is the file's answer, shown as such — the document
      // would otherwise throw the same parse error mid-render.
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }, [bytes, name]);
  if (parsed.kind === "error") {
    return (
      <Placeholder tone="error">
        Not a readable MIDI file: {parsed.message}
      </Placeholder>
    );
  }
  return (
    // One player per file: another file is a fresh player — drawn, played
    // and loading afresh — never this one's state carried over the switch.
    <SonataPlayerScope key={fileRefKey(file)}>
      <PlayerPreview file={file} bytes={bytes} meta={parsed.meta} />
    </SonataPlayerScope>
  );
}

/**
 * The preview inside its own player: loads the file as a file document, and
 * shows ONE loading state until the display has drawn (`usePlayerView().drawn`
 * — its code, its settings and its canvas are all in), only then revealing the
 * header, the roll and the transport together and starting playback. Laid out
 * (transparent, inert) meanwhile, so the display mounts, measures and draws behind it.
 */
function PlayerPreview({
  file,
  bytes,
  meta,
}: {
  file: FileRef;
  bytes: ArrayBuffer;
  meta: MidiSongMeta;
}) {
  const loadDocument = useLoadDocument();
  const { play } = useSession();
  const { drawn } = usePlayerView();
  const key = fileRefKey(file);
  useEffect(() => {
    // A file document: no library song, so no persisted settings — every
    // setting reads its default and nothing can be written for it.
    loadDocument({ kind: "file", key }, { [MIDI_SOURCE_ID]: bytes });
  }, [loadDocument, key, bytes]);

  // Opening a file plays it — once there is something to see play, never
  // under the loading state (the transport would read as playing over an
  // empty body, and the song's lead-in would run out behind it). Once: a
  // display re-drawing does not restart it (the scope is keyed per file). A
  // layout effect, so the reveal and the playing transport paint in the same
  // frame — a passive one lands after whatever work the reveal starts.
  const playedRef = useRef(false);
  useLayoutEffect(() => {
    if (!drawn || playedRef.current) return;
    playedRef.current = true;
    play();
  }, [drawn, play]);

  const { content } = useSongDocument();
  if (content.kind === "failed") {
    return (
      <Placeholder tone="error">
        Failed to compose the song: {String(content.failure.error)}
      </Placeholder>
    );
  }

  return (
    // Fills the host's body; the floor keeps the roll usable in a host whose
    // body has no definite height (a pane that scrolls its content).
    <Overlay
      fill
      className="h-full min-h-96"
      above={
        drawn ? null : (
          <Center axis="both" className="h-full">
            <Loading />
          </Center>
        )
      }
    >
      {content.kind === "ready" ? (
        <Column
          fill
          scrollBody={false}
          // Held transparent and inert, not `invisible`: a child's own
          // transition (a button's) would fade visibility back in after the
          // rest, revealing the player by stages again.
          className={cn("h-full", !drawn && "opacity-0")}
          inert={!drawn}
          header={
            <Inset x="lg" t="md" b="md">
              <Stack direction="row" gap="md" align="center">
                <Center
                  axis="both"
                  className={cn(
                    rigidClass(),
                    "size-11 rounded-lg bg-primary text-primary-foreground",
                  )}
                >
                  <Icon icon={musicIcon} className="size-6" />
                </Center>
                <Fill>
                  <Stack gap="2xs">
                    <Text variant="subheading">{meta.title}</Text>
                    <Facts
                      score={content.score}
                      durationSec={meta.durationSec}
                      size={bytes.byteLength}
                    />
                  </Stack>
                </Fill>
                <OpenInSonata file={file} bytes={bytes} />
              </Stack>
            </Inset>
          }
          body={
            <Inset x="lg" className="h-full">
              <Clip className="h-full rounded-lg border border-border">
                {/* A flex column, so the display's filling clip takes the
                    whole stage rather than its content's height. */}
                <Stack gap="none" className="h-full">
                  <PlayerDisplay displayId="piano-roll" />
                </Stack>
              </Clip>
            </Inset>
          }
          footer={
            <Inset x="lg" y="md">
              {/* The player's transport strip: play / pause, the scrubber
                  (which shows the playhead and duration, so no PlayerTime)
                  and loop. */}
              <PlayerTransport />
            </Inset>
          }
        />
      ) : null}
    </Overlay>
  );
}

function Facts({
  score,
  durationSec,
  size,
}: {
  score: Score;
  durationSec: number;
  size: number;
}) {
  const facts = useMemo(
    () => [
      { id: "duration", value: formatElapsed(durationSec * 1000) },
      ...midiFacts(score, size),
    ],
    [score, durationSec, size],
  );
  return (
    <Cluster gap="md">
      {facts.map((f) => (
        <Text key={f.id} variant="caption" tone="muted">
          <Text as="span" variant="caption" tone="strong">
            {f.value}
          </Text>
          {"unit" in f && f.unit ? ` ${f.unit}` : null}
        </Text>
      ))}
    </Cluster>
  );
}

/**
 * Put the file in the Sonata library (idempotent by content) and open it in
 * Sonata at the preview's playhead bar (the URL carries it; the label does not).
 */
function OpenInSonata({ file, bytes }: { file: FileRef; bytes: ArrayBuffer }) {
  const goToApp = useNavigate();
  const { score, stop } = useSession();
  const cursor = useCursorApi();
  const fetchEndpoint = useFetchEndpoint();
  const open = async () => {
    stop();
    // Anywhere in the first bar (or its lead-in) is "the start": no bar.
    const at = barPositionAt(score, cursor.getBeat()).bar;
    const bar = at > 1 ? at : undefined;
    try {
      const song = await importMidiBytes(
        fetchEndpoint,
        bytes,
        fileRefName(file),
      );
      goToApp(sonataSongLink(song.id, bar));
    } catch (err) {
      showToast({
        title: "Could not open in Sonata",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
      throw err;
    }
  };
  return (
    <Button onClick={open}>
      <Icon icon={pianoIcon} />
      Open in Sonata
    </Button>
  );
}
