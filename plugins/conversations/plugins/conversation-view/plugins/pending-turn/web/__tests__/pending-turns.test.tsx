/**
 * The browser's half of a send, against a stand-in for the live ledger read:
 * which ledger states draw a card (`pendingTurnsOf`), the hand-off from the
 * optimistic echo to the live row under the SAME client-minted id, a failed
 * request's Retry under that id, and the optimistic `working` status.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({
  /** What every `useLive(conversationTurns, …)` read answers. */
  result: { status: "loading", refetch: () => Promise.resolve() } as unknown,
}));

const posts = vi.hoisted(() => ({
  /** Every turn request: its route, path params and body. */
  calls: [] as { route: string; params: unknown; body: unknown }[],
  /** How the next request settles; `null` keeps it open. */
  next: "ok" as "ok" | "fail" | null,
  open: [] as (() => void)[],
}));

vi.mock("@plugins/network/plugins/live/web", () => ({
  useLive: () => ledger.result,
}));

vi.mock("@plugins/infra/plugins/endpoints/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchEndpoint: (
    endpoint: { route: string },
    params: unknown,
    init?: { body?: unknown },
  ) => {
    posts.calls.push({ route: endpoint.route, params, body: init?.body });
    if (posts.next === "fail") return Promise.reject(new Error("offline"));
    if (posts.next === null)
      return new Promise<void>((resolve) => posts.open.push(resolve));
    return Promise.resolve({});
  },
}));

import { act, renderHook } from "@testing-library/react";
import type {
  LedgerTurn,
  TurnId,
  TurnKind,
  TurnState,
} from "@plugins/conversations/plugins/turn-ledger/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  pendingTurnsOf,
  useOptimisticConversationStatus,
  usePendingTurns,
} from "../internal/pending";
import {
  resendTurn,
  sendConversationTurn,
  useTurnSendInFlight,
} from "../internal/send";

let seq = 0;
function freshConversation(): string {
  seq += 1;
  return `conv-pending-${seq}`;
}

function row(
  conversationId: string,
  id: string,
  state: TurnState,
  over: Partial<LedgerTurn> = {},
): LedgerTurn {
  return {
    id: id as TurnId,
    conversationId,
    kind: "turn" as TurnKind,
    text: `text of ${id}`,
    state,
    extraText: null,
    error: null,
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(Date.now() - 60_000),
    ...over,
  };
}

/** The transcript line a typed prompt lands as, written `at`. */
function prompt(text: string, at: Date): JsonlEvent {
  return {
    kind: "user-text",
    at: at.toISOString(),
    text,
    uuid: `uuid-${text}`,
  };
}

const NO_EVENTS: JsonlEvent[] = [];

/** The transcript read, answered with `events`. */
function transcript(events: JsonlEvent[]) {
  return {
    status: "ready" as const,
    data: events,
    refetch: () => Promise.resolve(),
  };
}

const NOT_IN_YET = {
  status: "loading" as const,
  refetch: () => Promise.resolve(),
};

function ready(rows: LedgerTurn[]): void {
  ledger.result = {
    status: "ready",
    data: rows,
    refetch: () => Promise.resolve(),
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  ledger.result = { status: "loading", refetch: () => Promise.resolve() };
  posts.calls = [];
  posts.next = "ok";
  posts.open = [];
});

describe("pendingTurnsOf — which ledger states draw a card", () => {
  const CARD: Record<TurnState, boolean> = {
    held: true,
    typing: true,
    // Echoes until the transcript shows the turn (none here).
    typed: true,
    accepted: true,
    merged: true,
    returned: false,
    failed: true,
    unverified: true,
    // Taken back into the draft by the user.
    withdrawn: false,
  };
  for (const [state, draws] of Object.entries(CARD) as [TurnState, boolean][]) {
    it(`${state} → ${draws ? "a card" : "nothing"}`, () => {
      const cards = pendingTurnsOf([row("c", "t1", state)], [], NO_EVENTS);
      expect(cards.map((c) => c.state)).toEqual(draws ? [state] : []);
    });
  }

  it("shows a merged warning only while its turn is the newest", () => {
    const merged = row("c", "old", "merged", { extraText: "stale draft" });
    expect(pendingTurnsOf([merged], [], NO_EVENTS)[0]?.extraText).toBe(
      "stale draft",
    );
    const newer = row("c", "new", "accepted");
    const both = [prompt("a", new Date()), prompt("b", new Date())];
    expect(pendingTurnsOf([newer, merged], [], both)).toEqual([]);
  });

  it("draws no in-flight echo for an answer, but its failure card", () => {
    const answer = (state: TurnState) =>
      row("c", "a", state, { kind: "answer" });
    expect(pendingTurnsOf([answer("typing")], [], NO_EVENTS)).toEqual([]);
    expect(pendingTurnsOf([answer("held")], [], NO_EVENTS)).toEqual([]);
    expect(
      pendingTurnsOf([answer("failed")], [], NO_EVENTS).map((c) => c.state),
    ).toEqual(["failed"]);
  });

  it("orders cards oldest first (the window reads newest first)", () => {
    const cards = pendingTurnsOf(
      [row("c", "second", "failed"), row("c", "first", "held")],
      [],
      NO_EVENTS,
    );
    expect(cards.map((c) => c.id)).toEqual(["first", "second"]);
  });

  it("an echo stands until the transcript shows the turn — whatever the ledger says", () => {
    const sentAt = new Date(Date.now() - 1_000);
    const accepted = row("c", "t1", "accepted", { createdAt: sentAt });
    expect(pendingTurnsOf([accepted], [], NO_EVENTS)).toEqual([
      expect.objectContaining({ id: "t1", state: "accepted" }),
    ]);
    const landed = [prompt("text of t1", new Date())];
    expect(pendingTurnsOf([accepted], [], landed)).toEqual([]);
  });

  it("a slash command echoes until the agent takes it, then draws nothing", () => {
    const sent = row("c", "t1", "typed", { text: "/compact" });
    expect(pendingTurnsOf([sent], [], NO_EVENTS)).toEqual([
      expect.objectContaining({ id: "t1", state: "typed" }),
    ]);
    const taken = row("c", "t1", "accepted", { text: "/compact" });
    expect(pendingTurnsOf([taken], [], NO_EVENTS)).toEqual([]);
  });
});

describe("send → optimistic echo → live row", () => {
  it("echoes at once, then hands over to the row written under its id", async () => {
    const conv = freshConversation();
    ready([]);
    posts.next = null;
    let events: JsonlEvent[] = [];
    const { result, rerender } = renderHook(() => ({
      pending: usePendingTurns(conv, transcript(events)),
      inFlight: useTurnSendInFlight(conv),
    }));

    let turnId = "";
    act(() => {
      turnId = sendConversationTurn(conv, { text: "fix the build" });
    });
    // The request carries the browser's id: the server writes its row under it.
    expect(posts.calls).toEqual([
      {
        route: "POST /api/conversations/:id/turn",
        params: { id: conv },
        body: { text: "fix the build", turnId },
      },
    ]);
    expect(turnId).toMatch(/^turn-/);
    const echoed = result.current.pending;
    expect(echoed.status === "ready" && echoed.data).toEqual([
      expect.objectContaining({ id: turnId, state: "sending" }),
    ]);
    expect(result.current.inFlight).toBe(true);

    // The live row lands before the response: one card, the row's.
    ready([row(conv, turnId, "typing", { text: "fix the build" })]);
    rerender();
    const handed = result.current.pending;
    expect(handed.status === "ready" && handed.data).toEqual([
      expect.objectContaining({ id: turnId, state: "typing" }),
    ]);
    expect(result.current.inFlight).toBe(true);

    act(() => posts.open.forEach((resolve) => resolve()));
    await settle();
    expect(result.current.inFlight).toBe(false);

    // The hook confirmed it, but the transcript has not shown it yet: the echo
    // stays — the message is not on screen.
    const sentAt = new Date(Date.now() - 1_000);
    ready([row(conv, turnId, "accepted", { createdAt: sentAt })]);
    rerender();
    const confirmed = result.current.pending;
    expect(confirmed.status === "ready" && confirmed.data).toEqual([
      expect.objectContaining({ id: turnId, state: "accepted" }),
    ]);

    // The transcript shows it: no card is left.
    events = [prompt("fix the build", new Date())];
    rerender();
    const done = result.current.pending;
    expect(done.status === "ready" && done.data).toEqual([]);
  });

  it("is loading until the ledger answers", () => {
    const conv = freshConversation();
    const { result } = renderHook(() =>
      usePendingTurns(conv, transcript(NO_EVENTS)),
    );
    expect(result.current.status).toBe("loading");
  });

  it("is loading until the transcript is in", () => {
    const conv = freshConversation();
    ready([]);
    const { result } = renderHook(() => usePendingTurns(conv, NOT_IN_YET));
    expect(result.current.status).toBe("loading");
  });

  it("keeps a failed request as `unsent`, and Retry re-sends the same id", async () => {
    const conv = freshConversation();
    ready([]);
    posts.next = "fail";
    const { result } = renderHook(() =>
      usePendingTurns(conv, transcript(NO_EVENTS)),
    );
    let turnId = "";
    act(() => {
      turnId = sendConversationTurn(conv, { text: "hello" });
    });
    await settle();
    const failed = result.current;
    expect(failed.status === "ready" && failed.data).toEqual([
      expect.objectContaining({
        id: turnId,
        state: "unsent",
        error: "offline",
      }),
    ]);

    posts.next = "ok";
    act(() => resendTurn(conv, turnId));
    expect(
      posts.calls.map((c) => (c.body as { turnId: string }).turnId),
    ).toEqual([turnId, turnId]);
    await settle();
    const resent = result.current;
    expect(resent.status === "ready" && resent.data).toEqual([
      expect.objectContaining({ id: turnId, state: "sending" }),
    ]);
  });
});

describe("useOptimisticConversationStatus", () => {
  function render(id: string, status: ConversationStatus, updatedAt: Date) {
    return renderHook(
      (props: { status: ConversationStatus; updatedAt: Date }) =>
        useOptimisticConversationStatus({ id, ...props }),
      { initialProps: { status, updatedAt } },
    );
  }

  it("passes the server status through when nothing was sent", () => {
    ready([]);
    const { result } = render(
      freshConversation(),
      "waiting",
      new Date(Date.now() - 1000),
    );
    expect(result.current).toBe("waiting");
  });

  it("reads working from the instant a turn is sent, until the server can know", async () => {
    const conv = freshConversation();
    ready([]);
    const before = new Date(Date.now() - 1000);
    const { result, rerender } = render(conv, "waiting", before);
    let turnId = "";
    act(() => {
      turnId = sendConversationTurn(conv, { text: "go" });
    });
    expect(result.current).toBe("working");
    await settle();

    // Typed, its hook still to come: the server cannot know yet.
    ready([row(conv, turnId, "typed", { createdAt: new Date() })]);
    rerender({ status: "waiting", updatedAt: before });
    expect(result.current).toBe("working");

    // The CLI confirmed it: from here the server's status is the one answer —
    // even one that never moved (the turn ended before a reconcile saw it).
    ready([row(conv, turnId, "accepted", { createdAt: new Date() })]);
    rerender({ status: "waiting", updatedAt: before });
    expect(result.current).toBe("waiting");
  });

  it("stops overriding once the server status moved after the send", () => {
    const conv = freshConversation();
    ready([row(conv, "t1", "typed", { createdAt: new Date() })]);
    const { result } = render(conv, "waiting", new Date(Date.now() + 5_000));
    expect(result.current).toBe("waiting");
  });

  it("does not override statuses other than waiting", () => {
    const conv = freshConversation();
    ready([]);
    const { result } = render(conv, "starting", new Date(Date.now() - 1000));
    act(() => {
      sendConversationTurn(conv, { text: "go" });
    });
    expect(result.current).toBe("starting");
  });

  it("retracts the override when the send fails", async () => {
    const conv = freshConversation();
    ready([]);
    const { result } = render(conv, "waiting", new Date(Date.now() - 1000));
    posts.next = "fail";
    act(() => {
      sendConversationTurn(conv, { text: "go" });
    });
    expect(result.current).toBe("working");
    await settle();
    expect(result.current).toBe("waiting");
  });

  it("ignores a failed ledger row and another conversation's turns", () => {
    const conv = freshConversation();
    ready([
      row(conv, "t1", "failed", { createdAt: new Date() }),
      row("someone-else", "t2", "typing", { createdAt: new Date() }),
    ]);
    const { result } = render(conv, "waiting", new Date(Date.now() - 1000));
    expect(result.current).toBe("waiting");
  });
});
