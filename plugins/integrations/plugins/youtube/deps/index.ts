// The youtube plugin's dependency: the `youtube-audio` env (yt-dlp), collected
// into infra/deps' registry through the `default` array (Settings →
// Dependencies, `./equin deps install youtube-audio`). Its modules are
// run by the search (server barrel) and the audio download (`audio-fetch`).
import { ytDlpDep } from "./internal/yt-dlp";

export { ytDlpDep } from "./internal/yt-dlp";

export default [ytDlpDep];
