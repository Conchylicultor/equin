import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FileViewer } from "@plugins/primitives/plugins/file-viewer/web";
import { AudioView, VideoView } from "./components/media-view";
import { supportsMedia } from "./internal/supports";

export default {
  description:
    "Video and audio player for host media files (.mp4, .mov, .webm, .mp3, .wav, .flac, …): the browser's native player with controls, auto-playing on open, Space to play / pause, seeking over byte ranges; a file the player cannot open (damaged or incomplete, unreadable, an unsupported codec) says why, with Retry and Open with default app.",
  contributions: [
    FileViewer.Renderer({
      id: "video",
      label: "Video",
      supports: ({ file }) => supportsMedia("video", file),
      component: VideoView,
    }),
    FileViewer.Renderer({
      id: "audio",
      label: "Audio",
      supports: ({ file }) => supportsMedia("audio", file),
      component: AudioView,
    }),
  ],
} satisfies PluginDefinition;
