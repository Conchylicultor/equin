import type { ReactNode } from "react";
import {
  ConversationItem,
  conversationTitle,
  type ConversationItemConv,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { afterOpen } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/**
 * How much room the row takes.
 *
 * One word instead of three mechanics: it picks the `ConversationItem` layout
 * AND the `Row`'s density, which a caller previously had to keep in step by
 * hand (`size="sm"` beside `layout="inline"`).
 */
export type ConversationRowLayout = "block" | "inline";

export interface ConversationRowChrome {
  /** `"block"` (default) is the full list line; `"inline"` the compact one. */
  layout?: ConversationRowLayout;
  /** Presentational trailing content, inside the row body. */
  trailing?: ReactNode;
  /** Interactive trailing controls — `Row`'s own actions slot. */
  actions?: ReactNode;
  /**
   * Called once the row has navigated, so a surface that must get out of the
   * way (a popover hung off a glyph) can dismiss itself. Not on a ⌘/middle-
   * click, which opens a browser tab and leaves this one where it is.
   */
  onOpen?: () => void;
}

export interface ConversationRowProps extends ConversationRowChrome {
  /**
   * The conversation to name. Structural, like `ConversationItem`'s own prop —
   * a full `Conversation` row and the narrower `ConversationSummary` carried by
   * the `attempts` set (`attemptRows`) both fit.
   */
  conv: ConversationItemConv;
}

export interface ConversationRowByIdProps extends ConversationRowChrome {
  /** The conversation to name, by id. */
  convId: string;
}

/**
 * A conversation, as a full-width list line that opens its run beside the
 * surface listing it.
 *
 * The sibling `item` plugin is pure presentation — it paints a conversation and
 * nothing else, so a row, a chip and a card can each wrap their own chrome
 * around one rendering. This is that wrapper for the row case, written once, as
 * `chip` is for the pill case. Four surfaces used to build it by hand and none
 * of them agreed on what "the open one" meant.
 *
 * Clicking the row opens its run in a column beside the surface, and clicking
 * the row that is already open closes that column again — the one navigation,
 * from `useConversationOpener`.
 */
export function ConversationRow({ conv, ...chrome }: ConversationRowProps) {
  return (
    <ConversationRowShell
      convId={conv.id}
      title={conversationTitle(conv)}
      {...chrome}
    >
      <ConversationItem conv={conv} layout={chrome.layout ?? "block"} />
    </ConversationRowShell>
  );
}

/**
 * The same row for a surface that holds only an id it has not resolved.
 *
 * `useConversationById` resolves any conversation live (its by-id read). It
 * answers `null` both while that read loads and when the conversation is
 * genuinely gone, and those two are indistinguishable from here — so the row
 * shows the raw id rather than claiming either. It stays clickable in that
 * state on purpose: the common `null` is "still loading", and going dead on it
 * would make a live link dead for its first frame.
 */
export function ConversationRowById({
  convId,
  ...chrome
}: ConversationRowByIdProps) {
  const conv = useConversationById(convId);
  if (conv) return <ConversationRow conv={conv} {...chrome} />;
  return (
    <ConversationRowShell convId={convId} title={convId} {...chrome}>
      <Text variant="caption" tone="muted">
        {convId}
      </Text>
    </ConversationRowShell>
  );
}

/** The chrome and the navigation, shared by both entry points. */
function ConversationRowShell({
  convId,
  title,
  layout = "block",
  trailing,
  actions,
  onOpen,
  children,
}: ConversationRowChrome & {
  convId: string;
  title: string;
  children: ReactNode;
}) {
  const opener = useConversationOpener();
  const inline = layout === "inline";
  const target = opener.toggle(convId);

  return (
    <Row
      size={inline ? "sm" : "md"}
      selected={opener.isOpen(convId)}
      title={title}
      actions={actions}
      {...activationProps(onOpen ? afterOpen(target, onOpen) : target)}
    >
      <Fill>{children}</Fill>
      {trailing}
    </Row>
  );
}
