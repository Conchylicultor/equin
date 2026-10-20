import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

export type AttachmentEvent = Extract<JsonlEvent, { kind: "attachment" }>;

export interface AttachmentRendererProps {
  event: AttachmentEvent;
}
