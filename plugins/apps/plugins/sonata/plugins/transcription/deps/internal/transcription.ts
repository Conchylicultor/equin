import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { pythonEnv } from "@plugins/infra/plugins/deps/plugins/python/deps";

/**
 * The `st` toolkit's Python env (`../../python`): yt-dlp, PyAV, verovio,
 * resvg-py, pypdfium2, pillow, numpy. Its own project so a yt-dlp bump never
 * touches the audio-analysis env (torch).
 */
export const transcriptionDep = defineDep({
  id: "sonata-transcription",
  owner: "apps/sonata/transcription",
  description:
    "Sonata transcription tools: yt-dlp, PyAV, verovio, resvg-py, pypdfium2, pillow",
  sizeHint: "≈150 MB",
  source: pythonEnv({
    project: "plugins/apps/plugins/sonata/plugins/transcription/python",
  }),
});
