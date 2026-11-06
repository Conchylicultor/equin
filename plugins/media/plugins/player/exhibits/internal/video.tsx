import { MediaPlayer } from "../../web/components/media-player";
import { clipSrc } from "./clip";

/** The video player over the test clip, paused at its first frame. */
export default function VideoExhibit() {
  return (
    <MediaPlayer
      kind="video"
      src={clipSrc}
      label="Test card"
      className="max-w-[1040px]"
    />
  );
}
