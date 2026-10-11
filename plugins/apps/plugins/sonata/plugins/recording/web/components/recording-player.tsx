import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  YouTubePlayer,
  useYouTubePlayerState,
} from "@plugins/integrations/plugins/youtube/web";
import { useConfig } from "@plugins/config_v2/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { recordingConfig, recordingVideoConfig } from "../../shared/config";
import { createVideoDriver } from "../driver";
import { faultOf } from "../internal/fault";
import { useRecordingStore } from "../internal/recording-store";
import { RefusalProvider } from "../refusal";
import { SonataRecording } from "../slots";

/**
 * The session's recording player (rendered by `RecordingProvider` for the
 * life of the session; it draws nothing in place). It owns the YouTube player
 * of the claimed video — rendered into the store's stage, which waits in an
 * off-screen parking spot until a `RecordingVideo` viewport moves it on screen — so the
 * video keeps playing, and keeps driving the transport, whatever shows it or
 * not: a collapsed section, a display switch, the library.
 *
 * - **Synced** (the open score is timed on this video,
 *   `score.meta.recording.videoId`): YouTube's controls are off and, while the
 *   player is ready, it is the session's transport driver.
 * - **Not synced**: it plays on its own with YouTube's controls; the synth
 *   keeps the score's own timing. Switching re-creates the player (its
 *   controls are fixed at creation).
 * - **Off** (`playVideo` false): no player at all; the synth plays alone on
 *   the same timing.
 *
 * A refusal (the video is gone or not embeddable) mounts
 * `SonataRecording.Refused` once for that video, shown or not.
 */
export function RecordingPlayer() {
  const { videoId, controller, stage, generation } = useRecordingStore();
  const { score, registerTransportDriver } = useSession();
  const { videoOn, videoVolume, syncOffsetMs } = useConfig(recordingConfig);
  const { playVideo } = useConfig(recordingVideoConfig);
  const offsetSecRef = useLatestRef(syncOffsetMs / 1000);

  const synced = videoId !== null && score.meta.recording?.videoId === videoId;
  const state = useYouTubePlayerState(controller);
  const ready = state.kind === "ready" && state.videoId === videoId;

  useEffect(() => {
    if (!synced || !ready) return;
    return registerTransportDriver(
      createVideoDriver(controller, () => offsetSecRef.current),
    );
  }, [synced, ready, controller, registerTransportDriver, offsetSecRef]);

  const fault = videoId === null ? null : faultOf(state, videoId);

  return (
    <>
      {playVideo &&
        videoId !== null &&
        createPortal(
          <YouTubePlayer
            // `generation`: a reload after a player fault creates it afresh.
            key={generation}
            controller={controller}
            videoId={videoId}
            loop={null}
            controls={!synced}
            audio={{ volume: videoVolume, muted: !videoOn }}
          />,
          stage,
        )}
      {fault?.kind === "refused" && (
        <RefusalProvider key={fault.refusal.videoId} refusal={fault.refusal}>
          <SonataRecording.Refused.Mount />
        </RefusalProvider>
      )}
    </>
  );
}
