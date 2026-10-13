/**
 * The reading pane's list over a thread's live pages: the newest-first pages
 * render reversed (oldest→newest), a page of older messages lands above the
 * cards shown without remounting any, and "Load older messages" appears
 * exactly while there is more — or a page is loading — and pages it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// A card hydrates its body through an endpoint; what it renders is not what
// this list is about.
vi.mock("../components/message-card", () => ({
  MessageCard: ({
    message,
    defaultOpen,
  }: {
    message: { id: string };
    defaultOpen: boolean;
  }) => (
    <div data-testid="card" data-open={String(defaultOpen)}>
      {message.id}
    </div>
  ),
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  mailAccountIdKind,
  type MailMessage,
} from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import type { ResourcePaging } from "@plugins/primitives/plugins/live-state/web";
import { MessageList } from "../components/message-list";

afterEach(cleanup);

const at = new Date("2026-01-01T00:00:00Z");

function message(id: string): MailMessage {
  return {
    id,
    threadId: "t1",
    accountId: mailAccountIdKind.key("a1"),
    from: { email: "a@example.com" },
    to: [],
    cc: [],
    bcc: [],
    replyTo: null,
    subject: "Hello",
    snippet: null,
    headers: {},
    bodyText: null,
    bodyHtml: null,
    bodyFetchedAt: null,
    internalDate: at,
    unread: false,
    starred: false,
    isDraft: false,
    isSent: false,
    hasAttachments: false,
    sizeEstimate: null,
    historyId: null,
    createdAt: at,
    updatedAt: at,
  };
}

function paging(over: Partial<ResourcePaging> = {}): ResourcePaging {
  return { canGrow: false, growing: false, loadMore: vi.fn(), ...over };
}

const LOAD_OLDER = { name: /load older messages/i };
const loadOlder = () => screen.queryByRole("button", LOAD_OLDER);

describe("MessageList", () => {
  it("renders the newest-first window oldest→newest, the newest one open", () => {
    render(
      <MessageList
        newestFirst={[message("m3"), message("m2"), message("m1")]}
        older={paging()}
      />,
    );
    const cards = screen.getAllByTestId("card");
    expect(cards.map((c) => c.textContent)).toEqual(["m1", "m2", "m3"]);
    expect(cards.map((c) => c.getAttribute("data-open"))).toEqual([
      "false",
      "false",
      "true",
    ]);
  });

  it("offers no older messages when the window holds the whole thread", () => {
    render(<MessageList newestFirst={[message("m1")]} older={paging()} />);
    expect(loadOlder()).toBeNull();
  });

  it("grows the window when older messages can be loaded", () => {
    const older = paging({ canGrow: true });
    render(<MessageList newestFirst={[message("m1")]} older={older} />);
    fireEvent.click(screen.getByRole("button", LOAD_OLDER));
    expect(older.loadMore).toHaveBeenCalledTimes(1);
  });

  it("keeps the button, loading, while the grown window loads", () => {
    render(
      <MessageList
        newestFirst={[message("m1")]}
        older={paging({ growing: true })}
      />,
    );
    const button = screen.getByRole("button", LOAD_OLDER);
    expect(button.getAttribute("data-loading")).toBe("true");
  });

  it("an older page lands above the shown cards, in order, remounting none", () => {
    const page0 = [message("m5"), message("m4"), message("m3")];
    const page1 = [message("m2"), message("m1")];
    const { rerender } = render(
      <MessageList newestFirst={page0} older={paging({ canGrow: true })} />,
    );
    const before = new Map(
      screen.getAllByTestId("card").map((c) => [c.textContent, c]),
    );
    // `loadMore` split: the pages are concatenated in window order, so the
    // older page follows page 0 — and comes first once reversed.
    rerender(
      <MessageList newestFirst={[...page0, ...page1]} older={paging()} />,
    );
    const cards = screen.getAllByTestId("card");
    expect(cards.map((c) => c.textContent)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
    for (const id of ["m3", "m4", "m5"]) {
      expect(cards.find((c) => c.textContent === id)).toBe(before.get(id));
    }
    expect(cards.at(-1)!.getAttribute("data-open")).toBe("true");
    expect(loadOlder()).toBeNull();
  });

  it("says the thread is empty when no message is loaded", () => {
    render(<MessageList newestFirst={[]} older={paging()} />);
    expect(screen.getByText("This thread has no messages.")).not.toBeNull();
    expect(loadOlder()).toBeNull();
  });
});
