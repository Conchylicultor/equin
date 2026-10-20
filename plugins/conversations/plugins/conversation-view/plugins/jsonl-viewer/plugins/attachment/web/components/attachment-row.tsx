import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { JsonlViewerAttachment } from "../slots";
import type { AttachmentEvent } from "../../core";

export function AttachmentRow({ event }: { event: JsonlEvent }) {
  const e = event as AttachmentEvent;
  return <JsonlViewerAttachment.Renderer.Dispatch event={e} />;
}
