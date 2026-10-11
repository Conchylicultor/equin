import { useLayoutEffect, useRef } from "react";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useYouTubePlayerState } from "@plugins/integrations/plugins/youtube/web";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Slider } from "@plugins/primitives/plugins/css/plugins/slider/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { recordingConfig, recordingVideoConfig } from "../../shared/config";
import { faultOf } from "../internal/fault";
import {
  canMoveStage,
  placeStage,
  useRecordingStore,
} from "../internal/recording-store";

const volumeOffIcon = symbol("volume-off");
const volumeDownIcon = symbol("volume-down");
const volumeUpIcon = symbol("volume-up");

/**
 * The song's recording, for whoever shows it (the UG alignment's Recording
 * section): the video (16:9) and its volume (on/off, slider, level) right
 * below it. Renders nothing while no recording is claimed
 * (`useShowRecording`).
 *
 * The player is NOT this component's: it belongs to the session
 * (`RecordingPlayer`), and this is only a viewport — mounting moves the
 * playing iframe in, unmounting moves it back to its off-screen parking spot.
 * So collapsing the section, or anything that remounts it, neither stops nor
 * reloads the video, and the transport stays synced to it. One viewport at a
 * time.
 *
 * Unsynced (the score is not timed on this video) it plays with YouTube's own
 * controls under a "Not synced" badge. Turned off (`RecordingSwitch`), it says
 * so in place of the video.
 */
export function RecordingVideo() {
  const { videoId, controller, reload } = useRecordingStore();
  const { score } = useSession();
  const { playVideo } = useConfig(recordingVideoConfig);
  const state = useYouTubePlayerState(controller);
  if (videoId === null) return null;
  if (!playVideo) {
    return (
      <Text variant="caption" tone="muted">
        The video is off: the synth plays on its own.
      </Text>
    );
  }
  const synced = score.meta.recording?.videoId === videoId;
  const fault = faultOf(state, videoId);
  return (
    <Stack gap="xs">
      <Clip className="relative aspect-video w-full rounded-md bg-muted">
        {canMoveStage ? (
          <StageViewport />
        ) : (
          <Text variant="caption" tone="muted" className="p-sm">
            This browser cannot show the playing video here (it has no
            Element.moveBefore); it plays on, unseen.
          </Text>
        )}
        {!synced && <NotSyncedBadge />}
      </Clip>
      {fault?.kind === "refused" && (
        <Text variant="caption" tone="destructive" role="alert">
          {fault.refusal.status === "gone"
            ? "This video is no longer on YouTube."
            : "YouTube does not allow this video to play here."}{" "}
          The synth plays on its own.
        </Text>
      )}
      {fault?.kind === "player" && (
        <Line className="gap-xs">
          <Fill>
            <Text variant="caption" tone="destructive" role="alert">
              The video player failed (YouTube error {fault.code}). The synth
              plays on its own.
            </Text>
          </Fill>
          <Button variant="ghost" onClick={reload}>
            Reload video
          </Button>
        </Line>
      )}
      <VideoVolume />
    </Stack>
  );
}

/**
 * Where the session's player shows: on mount the stage (the iframe's holder)
 * is moved in, on unmount back to the parking spot — before React detaches
 * this element, so the iframe is never out of the document.
 */
function StageViewport() {
  const { stage, parking } = useRecordingStore();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) throw new Error("StageViewport: element missing");
    placeStage(stage, el);
    return () => placeStage(stage, parking);
  }, [stage, parking]);
  return <div ref={ref} className="size-full" />;
}

/**
 * Over the video's top-left corner while it plays on its own (the synth keeps
 * the sheet's own timing): a dot and "Not synced" on a translucent dark pill —
 * the video behind is dark whatever the theme. Clicks pass through to
 * YouTube's controls.
 */
function NotSyncedBadge() {
  return (
    <Pin to="top-left" offset="sm" decorative>
      <Line className="gap-xs rounded-full bg-black/60 px-sm py-2xs text-white backdrop-blur-sm">
        <span className={`${rigidClass()} size-1.5 rounded-full bg-white/50`} />
        <Text variant="caption">Not synced</Text>
      </Line>
    </Pin>
  );
}

/**
 * The recording on/off switch (`sonata.recording-video`'s `playVideo`), for the
 * header of the section showing it — so it is reachable while that section is
 * collapsed. Off removes the player; the synth plays alone, on the same
 * timing. On creates it again, synced to where the transport is.
 */
export function RecordingSwitch() {
  const { playVideo } = useConfig(recordingVideoConfig);
  const setConfig = useSetConfig(recordingVideoConfig);
  return (
    <Switch
      checked={playVideo}
      onCheckedChange={(on) => setConfig("playVideo", on)}
      aria-label="Play the recording video"
    />
  );
}

/** The video's sound: on/off and its level (`sonata.recording`). Muting keeps it playing, so it still keeps time. */
function VideoVolume() {
  const { videoOn, videoVolume } = useConfig(recordingConfig);
  const setConfig = useSetConfig(recordingConfig);
  const silent = !videoOn || videoVolume === 0;
  return (
    <Line className="gap-xs">
      <IconButton
        icon={
          silent
            ? volumeOffIcon
            : videoVolume < 50
              ? volumeDownIcon
              : volumeUpIcon
        }
        label={videoOn ? "Mute the video" : "Unmute the video"}
        onClick={() => setConfig("videoOn", !videoOn)}
      />
      <Fill>
        <Slider
          value={videoVolume}
          min={0}
          max={100}
          step={1}
          onValueChange={(v) => {
            setConfig("videoVolume", v);
            if (!videoOn) setConfig("videoOn", true);
          }}
          aria-label="Video volume"
          className="w-full"
        />
      </Fill>
      <Text
        variant="caption"
        tone="muted"
        className={`${rigidClass()} w-6 text-right tabular-nums`}
      >
        {videoVolume}
      </Text>
    </Line>
  );
}
