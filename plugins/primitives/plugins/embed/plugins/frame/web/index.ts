import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  AppFrame,
  ContentFrame,
  FRAME_ACTIVITY_EVENT,
  ForeignFrame,
  InlineFrame,
  PdfFrame,
  useContentUrl,
} from "./components/frames";
export type { InlineFrameAllowance } from "./components/frames";
export { FrameChannelClosedError, FrameChannelError } from "./internal/channel";
export type { FrameChannel } from "./internal/channel";

export default {
  description:
    "The one framing primitive — every <iframe> in the app is one of its five frames, and frame/no-raw-frame rejects one anywhere else. ContentFrame: untrusted content (an access: { content } route's document, an agent-written prototype) on the content host (<item>.content.localhost, one origin per piece of content, never an app origin), talked to over the frame agent's channel (FrameChannel: CSS vars, screen height, scroll capture/restore, heights, activity — every reply untrusted data). ForeignFrame: a pasted third-party URL, classified first (an equin page, the content host, this computer or a non-web scheme is refused). InlineFrame: an HTML string in an opaque srcdoc sandbox. PdfFrame: a served PDF asset. AppFrame: the app itself at an in-app path, on this origin or another namespace's.",
  contributions: [],
} satisfies PluginDefinition;
