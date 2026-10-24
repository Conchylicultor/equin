/**
 * An answer in a thread renders like the transcript's assistant text, so a
 * `<go>` choice in it is live: its ▶ sends the choice as a turn of its own,
 * through the thread's composer (the prompt `AgentThreadView` provides and
 * `ThreadComposer` registers).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { TextEditorSlots } from "@plugins/primitives/plugins/text-editor/web";
import { activeDataPlugin } from "@plugins/active-data/web/testing";
import { goPlugin } from "@plugins/active-data/plugins/go/web/testing";
import {
  fakeFetchEndpoint,
  withTransport,
} from "@plugins/infra/plugins/endpoints/web/testing";
import type { ConversationEntry } from "@plugins/conversations/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { groupThread } from "../../core";
import { AgentThreadView } from "../components/agent-thread-view";
import { ThreadComposer } from "../components/composer";

afterEach(cleanup);

// The thread's sticky scroll watches its bottom sentinel; jsdom has no
// IntersectionObserver, and nothing here scrolls.
vi.stubGlobal(
  "IntersectionObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  },
);

// The slots the composer's editor renders, declared as their owner declares them.
const slotsPlugin = {
  id: "agent-thread-test-slots",
  description: "the text editor's plugin slot",
  slots: TextEditorSlots,
  contributions: [],
} as unknown as LoadedPlugin;

const CONVERSATION_ID = "conv-go-sends";

const events: JsonlEvent[] = [
  {
    kind: "user-text",
    at: "2026-10-23T09:00:00.000Z",
    text: "what next?",
    uuid: "u-1",
  },
  {
    kind: "assistant-text",
    at: "2026-10-23T09:00:05.000Z",
    messageId: "msg_1",
    text: "Done. Should I <go>push it</go>?",
  },
];

/** The row fields the composer reads; the rest of a row plays no part here. */
const conversation = {
  id: CONVERSATION_ID,
  claudeSessionId: "session-1",
} as unknown as ConversationEntry;

function Thread() {
  const status = { status: "waiting", waitingFor: null } as const;
  return (
    <AgentThreadView
      conversationId={CONVERSATION_ID}
      turns={groupThread(events, [], status)}
      state="done"
      renderResult={() => null}
      composer={
        <ThreadComposer
          conversation={conversation}
          status="waiting"
          turnRunning={false}
          placeholder="Reply…"
        />
      }
    />
  );
}

describe("a <go> in a thread's answer", () => {
  it("sends the choice as a turn when its ▶ is clicked", async () => {
    const fake = fakeFetchEndpoint();
    const Transport = withTransport(fake);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Transport>
          <PluginProvider plugins={[slotsPlugin, activeDataPlugin, goPlugin]}>
            <Thread />
          </PluginProvider>
        </Transport>
      </QueryClientProvider>,
    );

    await screen.findByText("push it");
    // The unit's ▶ (an inline span) — not the composer's own Send button.
    const send = await waitFor(() => {
      const cap = document.querySelector<HTMLElement>(
        'span[role="button"][aria-label="Send"]',
      );
      if (!cap) throw new Error("the <go> has no send cap yet");
      // Enabled once the composer has registered as the thread's prompt.
      expect(cap.getAttribute("aria-disabled")).toBeNull();
      return cap;
    });
    send.click();

    await waitFor(() => {
      const turns = fake.calls.filter(
        (c) => c.route === "POST /api/conversations/:id/turn",
      );
      expect(turns).toHaveLength(1);
      expect(turns[0]!.params).toEqual({ id: CONVERSATION_ID });
      expect((turns[0]!.body as { text: string }).text).toContain(
        "<go>push it</go>",
      );
    });
  });
});
