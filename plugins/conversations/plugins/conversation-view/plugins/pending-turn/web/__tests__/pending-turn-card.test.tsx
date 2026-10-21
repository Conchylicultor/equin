/**
 * `PendingTurnCard` by state: the echo while held or being typed, the merged
 * warning naming the other text, and Retry / Copy to draft on a failure — a
 * ledger row's through the server's retry / withdraw endpoints, a request that
 * never reached the server through the tab's own store.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ routes: [] as string[] }));

vi.mock("@plugins/infra/plugins/endpoints/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchEndpoint: (endpoint: { route: string }) => {
    calls.routes.push(endpoint.route);
    return Promise.resolve({});
  },
}));

// The real message chrome walks every inline-text renderer; the card's own
// choices are what this suite pins.
vi.mock(
  "@plugins/conversations/plugins/conversation-view/plugins/user-message/web",
  () => ({
    UserMessageCard: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    UserMessageText: ({ text }: { text: string }) => <p>{text}</p>,
  }),
);

import type React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  PendingTurnCard,
  type RenderEcho,
} from "../components/pending-turn-card";
import {
  CARD_OF,
  type PendingTurn,
  type PendingTurnState,
} from "../internal/pending";
import { conversationPromptDraft } from "../internal/prompt-draft";

const CONV = "conv-card";

/** A host's user row: the text, then the status the card hands it. */
const renderEcho: RenderEcho = (t, status) => (
  <div data-testid="echo">
    <div>{t.text}</div>
    {status}
  </div>
);

function turn(state: PendingTurnState, over: Partial<PendingTurn> = {}) {
  const card = CARD_OF[state];
  if (card === null) throw new Error(`${state} draws no card`);
  return {
    card,
    id: "turn-1",
    kind: "turn",
    text: "fix the build",
    sentAt: new Date("2026-10-21T10:00:00Z"),
    state,
    extraText: null,
    error: null,
    ...over,
  } satisfies PendingTurn;
}

afterEach(() => {
  cleanup();
  calls.routes = [];
  localStorage.clear();
});

describe("PendingTurnCard", () => {
  it("echoes a held turn as waiting for the agent", () => {
    render(
      <PendingTurnCard
        renderEcho={renderEcho}
        conversationId={CONV}
        turn={turn("held")}
        agentStarting={false}
      />,
    );
    expect(screen.getByText("fix the build")).toBeTruthy();
    expect(screen.getByText("Waiting for the agent to start…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("waits for the agent to start while it is starting, whatever the state", () => {
    for (const state of ["sending", "held", "typing", "typed"] as const) {
      render(
        <PendingTurnCard
          renderEcho={renderEcho}
          conversationId={CONV}
          turn={turn(state)}
          agentStarting
        />,
      );
      expect(screen.getByText("Waiting for the agent to start…")).toBeTruthy();
      cleanup();
    }
  });

  it("draws no activity of its own — the host's foot line does", () => {
    const { container } = render(
      <PendingTurnCard
        renderEcho={renderEcho}
        conversationId={CONV}
        turn={turn("typing")}
        agentStarting
      />,
    );
    expect(container.querySelector(".animate-bounce")).toBeNull();
  });

  it("echoes a turn being sent or typed", () => {
    for (const state of ["sending", "typing"] as const) {
      render(
        <PendingTurnCard
          renderEcho={renderEcho}
          conversationId={CONV}
          turn={turn(state)}
          agentStarting={false}
        />,
      );
      expect(screen.getByText("Sending…")).toBeTruthy();
      cleanup();
    }
  });

  it("names the text a merged turn was submitted with", () => {
    render(
      <PendingTurnCard
        renderEcho={renderEcho}
        conversationId={CONV}
        turn={turn("merged", { extraText: "an old draft" })}
        agentStarting={false}
      />,
    );
    expect(screen.getByText("an old draft")).toBeTruthy();
    expect(screen.getByText(/together with other text/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry on a failed row, through the server's retry", async () => {
    render(
      <PendingTurnCard
        renderEcho={renderEcho}
        conversationId={CONV}
        turn={turn("failed", { error: "input box not empty" })}
        agentStarting={false}
      />,
    );
    expect(
      screen.getByText(/Failed to send — input box not empty/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(calls.routes).toEqual([
        "POST /api/conversations/:id/turns/:turnId/retry",
      ]),
    );
  });

  it("Copy to draft withdraws an unverified row and fills the draft", async () => {
    render(
      <PendingTurnCard
        renderEcho={renderEcho}
        conversationId={CONV}
        turn={turn("unverified")}
        agentStarting={false}
      />,
    );
    expect(screen.getByText(/Not confirmed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy to draft" }));
    await waitFor(() =>
      expect(calls.routes).toEqual([
        "POST /api/conversations/:id/turns/:turnId/withdraw",
      ]),
    );
    const stored = conversationPromptDraft.read(CONV);
    expect(stored.kind === "value" ? stored.value : null).toBe("fix the build");
  });

  it("an unsent request retries and withdraws in the tab: no ledger call", () => {
    render(
      <PendingTurnCard
        renderEcho={renderEcho}
        conversationId={CONV}
        turn={turn("unsent", { error: "offline" })}
        agentStarting={false}
      />,
    );
    expect(screen.getByText(/Failed to send — offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy to draft" }));
    expect(calls.routes).toEqual([]);
  });

  it("draws the echo as the host's own row, undimmed, the status under it", () => {
    render(
      <PendingTurnCard
        renderEcho={renderEcho}
        conversationId={CONV}
        turn={turn("sending")}
        agentStarting={false}
      />,
    );
    const echo = screen.getByTestId("echo");
    expect(echo.textContent).toBe("fix the buildSending…");
    expect(echo.closest(".opacity-70")).toBeNull();
  });

  it("echoes a typed turn as waiting in the agent's queue", () => {
    render(
      <PendingTurnCard
        renderEcho={renderEcho}
        conversationId={CONV}
        turn={turn("typed")}
        agentStarting={false}
      />,
    );
    expect(screen.getByText("Waiting for the agent to take it…")).toBeTruthy();
  });

  it("echoes an accepted turn (pendingTurnsOf drops it once the transcript shows it)", () => {
    const { container } = render(
      <PendingTurnCard
        renderEcho={renderEcho}
        conversationId={CONV}
        turn={turn("accepted")}
        agentStarting={false}
      />,
    );
    expect(container.textContent).toContain("Sending…");
  });
});
