import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { MediaPlayer } from "../../web/components/media-player";
import { clipSrc } from "./clip";

/** The audio bar over the test clip's tone, with room above it for its panels. */
export default function AudioExhibit() {
  return (
    <Stack direction="col" gap="none" justify="end" className="h-72 p-lg">
      <MediaPlayer kind="audio" src={clipSrc} label="Test tone" />
    </Stack>
  );
}
