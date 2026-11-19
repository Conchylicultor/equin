import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  MediaPlayError,
  playMedia,
  type PlayOutcome,
} from "./internal/media-play";
export {
  videoPipSupport,
  type VideoPipOutcome,
  type VideoPipSupport,
} from "./internal/video-pip";

export default {
  description:
    "A media element's requests the browser may refuse, with every refusal a value: playMedia(el) answers playing or refused (no-gesture / overtaken / source-failed with the element's MediaError, which its error event already reports) and throws only a MediaPlayError carrying the caller's stack and the element's state; videoPipSupport(doc?) answers unsupported or supported with request(video) → entered | refused. Its lint rules (no-raw-media-play, no-raw-request-picture-in-picture) send every other HTMLMediaElement .play() promise and .requestPictureInPicture() call here.",
  contributions: [],
} satisfies PluginDefinition;
