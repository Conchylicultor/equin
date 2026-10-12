import { useMemo } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "./panes";

/**
 * How a surface opens a conversation, and how it knows which one it has open.
 *
 * Six surfaces render "a conversation you can click to open its run" — task
 * detail's attempts, the launched-attempts card in a transcript, an agent-note
 * card's authors, a TODO card's latest run, the `conv-<id>` token in prose, and
 * the shared chip. Each used to spell the navigation itself, so the pane mode,
 * the "is this the open one" rule and whether a second click closes the column
 * were four different answers to the same question. They are one here.
 */
export interface ConversationOpener {
  /** The conversation column this surface has open, or `null`. */
  openConvId: string | null;
  /** Is this the conversation this surface has open? */
  isOpen(convId: string): boolean;
  /**
   * The link that opens this conversation beside the surface — or closes it,
   * when it is the one already open. Opening a conversation is a toggle
   * everywhere, so a row that lights up when you open it also puts itself out
   * when you click it again. Its `href` is always the opened route's URL: a
   * ⌘/middle-click opens the conversation in a new browser tab, never closes.
   */
  toggle(convId: string): LinkTarget;
  /** The link that opens this conversation as its own page (a fresh route). */
  asPage(convId: string): LinkTarget;
}

export function useConversationOpener(): ConversationOpener {
  const openPane = useOpenPane();
  // The conversation column THIS surface opened — the pane primitive's own
  // answer, rather than a guess made from the shape of the chain.
  const opened = conversationPane.useOpenedHere();

  return useMemo(() => {
    const openConvId = opened?.params.convId ?? null;
    return {
      openConvId,
      isOpen: (convId) => convId === openConvId,
      toggle: (convId) => {
        const push = openPane.to(
          conversationPane,
          { convId },
          { mode: "push" },
        );
        return {
          open: () => {
            if (opened && convId === openConvId) {
              conversationPane.close(opened.instanceId);
            } else {
              push.open();
            }
          },
          href: push.href,
        };
      },
      asPage: (convId) =>
        openPane.to(conversationPane, { convId }, { mode: "root" }),
    } satisfies ConversationOpener;
  }, [opened, openPane]);
}
