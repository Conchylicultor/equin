import { useEffect } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useMediaRefusal } from "@plugins/apps/plugins/sonata/plugins/recording/web";
import { refuseUgAlignmentVideo } from "../../core";
import { useUgLibrarySong } from "../internal/use-ug-raw";

/**
 * Headless (`SonataRecording.Refused`): the player refused the recording's
 * video, so tell the alignment — its candidate is marked unplayable and, when
 * the resolver had picked it, the pick moves on to the next candidate.
 *
 * Reported once per mount, keyed on the video. The panel mounts this again
 * when it remounts on the same refused video; the endpoint is idempotent, so a
 * repeat changes nothing. Only a library UG song has an alignment to tell.
 */
export function ReportVideoRefused() {
  const refusal = useMediaRefusal();
  const song = useUgLibrarySong();
  const songId = song?.songId ?? null;
  const report = useEndpointMutation(refuseUgAlignmentVideo);
  // On a host without the computer there is no resolver to tell.
  const mutate = report.kind === "available" ? report.mutate : null;

  useEffect(() => {
    if (songId === null || mutate === null) return;
    mutate({
      params: { id: songId },
      body: { videoId: refusal.videoId, status: refusal.status },
    });
  }, [songId, refusal.videoId, refusal.status, mutate]);

  return null;
}
