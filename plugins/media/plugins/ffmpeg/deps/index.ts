// ffmpeg + ffprobe, installed on demand. Host-only, like every `deps/` barrel;
// collected into infra/deps' registry through the `default` array.
import { ffmpeg } from "./internal/ffmpeg";

export { ffmpeg, ffmpegPaths, resolveFfmpeg } from "./internal/ffmpeg";
export type { FfmpegPaths } from "./internal/ffmpeg";

export default [ffmpeg];
