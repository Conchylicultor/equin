import {
  defineRenderSlot,
  defineDispatchSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { ComponentType } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import type { Conversation } from "@plugins/tasks/plugins/tasks-core/core";
import { UnknownEventRow } from "./components/unknown-event-row";
import { PendingContentIndicator } from "./components/pending-content-indicator";

/**
 * Pinned beside a transcript's scroller. Takes no props: read the transcript
 * via `useTranscriptEvents()` and the viewport via `paneScrollScope` — never
 * by conversation id, since a sub-agent's transcript is drawn under its
 * parent's id.
 */
export interface OverlayContribution {
  id: string;
  component: ComponentType;
}

/**
 * Action rendered alongside a "content pending in terminal" indicator — the
 * generic fallback and the AskUserQuestion "Answer here" surface both host it.
 * Owned here so the plugin that owns the terminal pane (terminal-pane) can
 * contribute an "Open terminal" affordance without jsonl-viewer importing it
 * (which would form an import cycle). Contributions read their own conversation
 * context (e.g. `conversationPane.useParams()`); no props are passed.
 */
export interface PendingPromptActionContribution {
  id: string;
  component: ComponentType;
}

/**
 * Logic-only contribution: a predicate that, when it returns true for an event,
 * removes that event from the rendered JSONL flow. Generic — contributors own
 * the rule (e.g. suppress a raw answer turn already shown inside a card). This
 * is a behavior slot (no component), so it is read directly via
 * `.useContributions()` rather than rendered through Dispatch/Render — the
 * EventRenderer's predicate tier can't win when another plugin already owns the
 * exact event-kind key.
 */
export interface EventFilterContribution {
  id: string;
  hide: (event: JsonlEvent) => boolean;
}

/**
 * Rendered at the end of a conversation's transcript, inside the scroller —
 * it scrolls with the transcript instead of staying pinned like the composer
 * dock (`Conversation.AbovePromptInput`). For a conversation's closing card
 * (e.g. the outcome report), which must not hide the transcript above it.
 */
export interface TranscriptEndContribution {
  id: string;
  component: ComponentType<{ conversation: Conversation }>;
}

/**
 * What an event is to the reader, as far as folding harness context goes:
 *
 * - `context` — model context the harness injected (instructions, environment,
 *   tool / skill / agent listings…). A run of these folds behind one rule.
 * - `ambient` — joins a context run it sits in or next to, but never starts
 *   one: an unrendered attachment subtype, a `System · informational` notice.
 *   On its own it stays a row.
 * - `conversation` — breaks a run. The default for any event nobody classifies.
 */
export type ContextRole = "context" | "ambient" | "conversation";

/**
 * Logic-only contribution classifying events for the context fold. Each
 * contributor answers only for the events it owns (`undefined` otherwise); the
 * first answer wins. A `fallback` contribution is asked only when no regular
 * one answered — the attachment plugin's "any subtype nobody renders is
 * ambient" rule.
 *
 * Folding never removes an event: every member still renders through its own
 * `EventRow`, behind a closed disclosure. Readers of the event list (stats,
 * artifacts, outline) are unaffected.
 */
export interface ContextRoleContribution {
  id: string;
  role: (event: JsonlEvent) => ContextRole | undefined;
  fallback?: boolean;
}

/**
 * `hostsContext`: the run of context events directly after this event folds
 * INTO its row instead of standing as its own fold. The renderer must place it
 * (`useHostedContext()` → `<ContextFold>`); `EventRow` throws in dev when a host
 * never reads it. Only exact-string `match`es can host.
 */
export interface EventRendererMeta {
  hostsContext?: true;
}

export const JsonlViewer = {
  EventRenderer: defineDispatchSlot<
    { event: JsonlEvent },
    JsonlEvent["kind"],
    EventRendererMeta
  >({
    key: (p) => p.event.kind,
    fallback: UnknownEventRow,
    docLabel: (c) => String(c.match),
  }),
  PendingPrompt: defineDispatchSlot<
    { conversationId: string; waitingFor: string },
    string
  >({
    key: (p) => p.waitingFor,
    fallback: PendingContentIndicator,
    docLabel: (c) => String(c.match),
  }),
  EventFilter: defineSlot<EventFilterContribution>({ docLabel: (p) => p.id }),
  ContextRole: defineSlot<ContextRoleContribution>({ docLabel: (p) => p.id }),
  Overlay: defineRenderSlot<OverlayContribution>({ docLabel: (p) => p.id }),
  PendingPromptAction: defineRenderSlot<PendingPromptActionContribution>({
    docLabel: (p) => p.id,
  }),
  TranscriptEnd: defineRenderSlot<TranscriptEndContribution>({
    docLabel: (p) => p.id,
  }),
};
