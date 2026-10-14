import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { JsonlViewer as JsonlViewerSlots } from "./slots";
import { RawJsonAction } from "./components/raw-json-button";
import { TimestampAction } from "./components/timestamp-action";

export { JsonlViewer } from "./slots";
export type {
  OverlayContribution,
  EventFilterContribution,
  ContextRole,
  ContextRoleContribution,
  EventRendererMeta,
} from "./slots";
export { ContextFold } from "./components/context-fold";
export { useHostedContext } from "./components/hosted-context";
export type { ContextMember } from "./components/hosted-context";
export { JsonlPane } from "./components/jsonl-pane";
export { TranscriptView } from "./components/transcript-view";
export type { TranscriptViewProps } from "./components/transcript-view";
export { useVisibleEvents } from "./use-visible-events";
export { EventLine } from "./components/event-line";
export { useRowMarkdown } from "./components/row-markdown-context";
export { useLastAssistantEvent } from "./components/last-assistant-context";
export { useTranscriptEvents } from "./components/transcript-events-context";
export { useTranscriptSubject } from "./components/transcript-subject-context";
export type { TranscriptSubject } from "./components/transcript-subject-context";
export { useJsonlConversationId } from "./components/conversation-id-context";
export { paneScrollScope } from "./components/pane-scroll-scope";
export { formatTime, formatTokenCount } from "./utils";
export { Timestamp } from "./components/timestamp";
export { useSectionExpand } from "./components/section-sticky-context";
export type { SectionExpand } from "./components/section-sticky-context";

export default {
  description:
    "Renders the raw Claude JSONL session log as the conversation's main content. Hosts the JsonlViewer.EventRenderer slot for child plugins to render specific event kinds.",
  contributions: [
    JsonlRowActions.Item({ id: "timestamp", component: TimestampAction }),
    JsonlRowActions.Item({ id: "raw-json", component: RawJsonAction }),
  ],
  slots: JsonlViewerSlots,
} satisfies PluginDefinition;
