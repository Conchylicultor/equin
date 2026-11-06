import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// App exhibits: the player registers surface shortcuts and wears a fixed
// theme the live app paints. The clip is a 5 s test card with a 440 Hz tone
// (`internal/clip.mp4`, made once with the media/ffmpeg dependency).
export default [
  appExhibit({
    id: "media-player/video",
    label: "Media player (video)",
    widths: [480, 760, 1040],
    load: () => import("./internal/video"),
  }),
  appExhibit({
    id: "media-player/audio",
    label: "Media player (audio)",
    widths: [360, 480, 640],
    load: () => import("./internal/audio"),
  }),
];
