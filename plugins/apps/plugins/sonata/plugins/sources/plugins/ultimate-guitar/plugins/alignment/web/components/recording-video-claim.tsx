import { useShowRecording } from "@plugins/apps/plugins/sonata/plugins/recording/web";
import { useUgAlignment } from "../internal/use-ug-raw";
import { recordingVideoId } from "../internal/recording-state";

/**
 * Headless (`Sonata.Effect`): declares the open UG song's recording — the
 * video the applied alignment is for, else the chosen one — to the session's
 * recording player. Lives outside the Recording section because a section
 * body unmounts while collapsed, and the video must play on.
 */
export function UgRecordingVideo() {
  const { raw, row } = useUgAlignment();
  useShowRecording(raw === undefined ? null : recordingVideoId(raw, row));
  return null;
}
