import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { ArtifactItem } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";

/**
 * One kind of artifact a conversation can produce — prototypes, pages, research
 * docs, screenshots, skills, and whatever comes next.
 *
 * The kind is split in two halves on purpose, and the split is what makes the
 * button possible at all:
 *
 * - The **server half** (`ConversationArtifactExtractor` in artifacts/server,
 *   same `id`): a pure `extract` over transcript events plus the kind's
 *   `origin`, run over the whole transcript on the server, so the count on the
 *   closed button exists before any section is mounted.
 * - This **web half** — `Section` is the component. A kind's titles usually need a lookup (the
 *   prototypes list, a page's name), and a lookup is a hook — so it lives here,
 *   inside the kind's own component, mounted only while the popover is open.
 */
export interface ArtifactKind {
  /** Section heading — plural, e.g. "Prototypes". */
  label: string;
  /** The kind's glyph, drawn at the left of each of its rows. */
  icon: IconRef;
  /**
   * Renders this kind's items in its own layout (rows, a thumbnail grid, name
   * chips) and decides where a click goes. Only ever mounted with a non-empty
   * list — the host skips a kind that found nothing.
   */
  Section: ComponentType<{ items: ArtifactItem[] }>;
}

export const ConversationArtifacts = {
  Kind: defineRenderSlot<ArtifactKind>({ docLabel: (kind) => kind.label }),
};
