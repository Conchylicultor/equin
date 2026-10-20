import type { ComponentType } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import type { AttachmentEvent, AttachmentRendererProps } from "../core";
import { JsonlViewerAttachment } from "./slots";

/**
 * What a rendered attachment subtype is to the reader:
 *
 * - `context` — model context the harness injected (instructions, environment,
 *   listings…). It folds with its neighbours behind a `Session context` /
 *   `Context update` rule, or into a compaction divider.
 * - `conversation` — something that happened in the conversation (a file the
 *   user attached, a hook error, a queued prompt). It stays a row and breaks a
 *   fold.
 *
 * A subtype whose events differ (a hook's output is context at SessionStart, a
 * row mid-turn) decides per event: `role` is then a function of the event.
 *
 * A subtype nobody renders is `ambient`: it joins a fold it sits in, never
 * starts one (`unrenderedAttachmentRole`).
 */
export type AttachmentRole = "context" | "conversation";

/**
 * Registers one attachment subtype: its renderer AND its context role, in one
 * declaration, so the two cannot name different subtypes and a new subtype
 * cannot be added without deciding whether it folds. Spread it into
 * `contributions`.
 */
export function attachmentRenderer({
  match,
  component,
  role,
}: {
  match: string;
  component: ComponentType<AttachmentRendererProps>;
  role: AttachmentRole | ((event: AttachmentEvent) => AttachmentRole);
}) {
  return [
    JsonlViewerAttachment.Renderer({ match, component }),
    JsonlViewer.ContextRole({
      id: `attachment:${match}`,
      role: (e) =>
        e.kind === "attachment" && e.subtype === match
          ? typeof role === "function"
            ? role(e)
            : role
          : undefined,
    }),
  ] as const;
}

/** The fallback role: an attachment subtype no plugin renders joins a context fold it sits in. */
export function unrenderedAttachmentRole(e: JsonlEvent) {
  return e.kind === "attachment" ? ("ambient" as const) : undefined;
}
