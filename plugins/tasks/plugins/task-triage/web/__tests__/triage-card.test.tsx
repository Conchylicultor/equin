/**
 * The Triage card, driven through its real components with the live reads,
 * the endpoints, the approval and the conversation opener stubbed: it renders
 * every state of a triage row (none, queued, running, done, stale, failed),
 * stays loading — never "Not triaged" — while the row is unknown, and Approve
 * works whether or not triage ever ran.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

type RowRead =
  | { status: "loading"; refetch: () => Promise<void> }
  | { status: "ready"; found: false; refetch: () => Promise<void> }
  | {
      status: "ready";
      found: true;
      row: unknown;
      refetch: () => Promise<void>;
    };

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  queued: [] as unknown[],
  approval: undefined as unknown,
  calls: [] as { route: string; args: unknown }[],
  approvals: [] as { taskId: string; approved: boolean }[],
  toggled: [] as string[],
}));

vi.mock("@plugins/network/plugins/live/web", () => ({
  useLiveRow: (collection: { key: string }) =>
    state.rows[collection.key] ?? {
      status: "loading",
      refetch: () => Promise.resolve(),
    },
  useLive: () => ({
    status: "ready",
    data: state.queued,
    refetch: () => Promise.resolve(),
    canGrow: false,
    growing: false,
    loadMore: () => {},
  }),
  mapRow: (
    result: RowRead,
    fn: (row: unknown) => unknown,
  ): { status: string; data?: unknown; refetch: () => Promise<void> } =>
    result.status === "ready"
      ? {
          status: "ready",
          data: fn(result.found ? result.row : null),
          refetch: result.refetch,
        }
      : result,
}));

vi.mock("@plugins/infra/plugins/endpoints/web", () => {
  class EndpointError extends Error {}
  return {
    EndpointError,
    useEndpointMutation: (endpoint: { route: string }) => ({
      mutateAsync: (args: unknown) => {
        state.calls.push({ route: endpoint.route, args });
        return Promise.resolve();
      },
    }),
    fetchEndpoint: (
      endpoint: { route: string },
      params: unknown,
      opts: unknown,
    ) => {
      state.calls.push({ route: endpoint.route, args: { params, opts } });
      return Promise.resolve();
    },
  };
});

vi.mock("@plugins/tasks/plugins/automations/web", () => ({
  useTaskApproval: () => state.approval,
  setTaskApproval: (taskId: string, approved: boolean) => {
    state.approvals.push({ taskId, approved });
    return Promise.resolve();
  },
}));

vi.mock("@plugins/conversations/plugins/conversation-view/web", () => ({
  useConversationOpener: () => ({
    openConvId: null,
    isOpen: () => false,
    toggle: (convId: string) => () => state.toggled.push(convId),
    asPage: (convId: string) => () => state.toggled.push(convId),
  }),
}));

vi.mock("@plugins/tasks/plugins/task-detail/web", () => ({
  useRegisterFlush: () => {},
}));

vi.mock("@plugins/primitives/plugins/markdown/web", () => ({
  Markdown: ({ children }: { children: string }) => <p>{children}</p>,
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TaskTriageRow } from "../../core";
import { TriageCard } from "../components/triage-card";
import { TriageActions, TriageSummary } from "../components/triage-header";

const TASK = "task-1";
const refetch = () => Promise.resolve();
const REQUESTED = new Date("2026-10-20T10:00:00Z");
const TRIAGED = new Date("2026-10-20T10:05:00Z");

const EMPTY: TaskTriageRow = {
  taskId: TASK,
  state: "queued",
  staleReason: null,
  conversationId: null,
  runTaskId: null,
  requestedAt: REQUESTED,
  startedAt: null,
  triagedAt: null,
  error: null,
  verdict: null,
  priority: null,
  taskType: null,
  risk: null,
  context: null,
  question: null,
  answers: [],
  answer: null,
  areas: [],
  mainSha: null,
};

const READ = {
  triagedAt: TRIAGED,
  mainSha: "abc123",
  verdict: "decide",
  priority: "should",
  taskType: "bugfix",
  risk: "medium",
  context: "Scroll anchoring uses the pre-zoom width.",
  question: "Which point should stay fixed?",
  answers: ["Playhead", "Pointer"],
  areas: ["sonata/piano-roll"],
} as const satisfies Partial<TaskTriageRow>;

function triage(row: Partial<TaskTriageRow> | null) {
  state.rows["task-triage.reads"] =
    row === null
      ? { status: "ready", found: false, refetch }
      : {
          status: "ready",
          found: true,
          row: { ...EMPTY, ...row, answers: [...(row.answers ?? [])] },
          refetch,
        };
}

function renderCard() {
  return render(
    <>
      <TriageSummary taskId={TASK} />
      <TriageActions taskId={TASK} />
      <TriageCard taskId={TASK} />
    </>,
  );
}

beforeEach(() => {
  state.rows = {
    "task-triage.notes": { status: "ready", found: false, refetch },
  };
  state.queued = [];
  state.approval = { status: "ready", data: null, refetch };
  state.calls = [];
  state.approvals = [];
  state.toggled = [];
});

afterEach(() => {
  cleanup();
});

describe("TriageCard", () => {
  it("stays loading while the row is unknown — never 'Not triaged'", () => {
    renderCard();
    expect(screen.queryByText("Not triaged")).toBeNull();
    expect(screen.queryByRole("button", { name: /Run triage/ })).toBeNull();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("offers Run triage when the task has none, and runs it", () => {
    triage(null);
    renderCard();
    expect(screen.getByText("Not triaged")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Run triage/ }));
    expect(state.calls).toEqual([
      {
        route: "POST /api/tasks/:taskId/triage",
        args: { params: { taskId: TASK } },
      },
    ]);
  });

  it("shows a queued run's place in the queue", () => {
    triage({ state: "queued", requestedAt: REQUESTED });
    state.queued = [
      {
        ...EMPTY,
        taskId: "task-0",
        requestedAt: new Date("2026-10-20T09:00:00Z"),
      },
      { ...EMPTY },
    ];
    renderCard();
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("1 ahead")).toBeTruthy();
    expect(screen.getByText("Waiting for a free slot…")).toBeTruthy();
  });

  it("shows a running run with its conversation", () => {
    triage({
      state: "running",
      startedAt: new Date(),
      conversationId: "conv-1",
    });
    renderCard();
    expect(screen.getByText("Triaging")).toBeTruthy();
    expect(screen.getByText(/Started/)).toBeTruthy();
    expect(screen.getByText("An agent is reading the task…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Conversation/ }));
    expect(state.toggled).toEqual(["conv-1"]);
    expect(screen.queryByRole("button", { name: /Re-run/ })).toBeNull();
  });

  it("shows a done read: stats, summary, question; answering it", () => {
    triage({ state: "done", conversationId: "conv-1", ...READ });
    renderCard();
    expect(screen.getByText("Triaged")).toBeTruthy();
    expect(screen.getByText(/^Ran/)).toBeTruthy();
    for (const label of ["Decide", "Should", "Bugfix", "Medium risk"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText(READ.context)).toBeTruthy();
    expect(screen.getByText(READ.question)).toBeTruthy();
    // Re-run sits in the header on a current read.
    expect(screen.getAllByRole("button", { name: /Re-run/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Pointer" }));
    expect(state.calls).toEqual([
      {
        route: "PUT /api/tasks/:taskId/triage/answer",
        args: { params: { taskId: TASK }, body: { answer: "Pointer" } },
      },
    ]);
  });

  it("clears a picked answer when it is clicked again", () => {
    triage({ state: "done", ...READ, answer: "Playhead" });
    renderCard();
    const chip = screen.getByRole("button", { name: "Playhead" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(state.calls.at(-1)).toEqual({
      route: "PUT /api/tasks/:taskId/triage/answer",
      args: { params: { taskId: TASK }, body: { answer: null } },
    });
  });

  it("shows a stale read under a notice with its reason and Re-run", () => {
    triage({ state: "stale", staleReason: "edited", ...READ });
    renderCard();
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText(/the task was edited after it ran/)).toBeTruthy();
    expect(screen.getByText("Decide")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Re-run/ }));
    expect(state.calls.at(-1)?.route).toBe("POST /api/tasks/:taskId/triage");
  });

  it("shows a failed run's error, its conversation and Re-run", () => {
    triage({
      state: "failed",
      error: "The conversation closed without a read.",
      conversationId: "conv-2",
    });
    renderCard();
    expect(screen.getByText("Triage failed")).toBeTruthy();
    expect(
      screen.getByText(/The conversation closed without a read\./),
    ).toBeTruthy();
    // One Conversation in the header, one beside the error.
    expect(
      screen.getAllByRole("button", { name: /Conversation/ }),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Re-run/ }));
    expect(state.calls.at(-1)?.route).toBe("POST /api/tasks/:taskId/triage");
  });
});

describe("Approve", () => {
  it("approves a task that was never triaged", () => {
    triage(null);
    renderCard();
    expect(screen.getByText("Approval doesn't require a triage.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(state.approvals).toEqual([{ taskId: TASK, approved: true }]);
  });

  it("takes an approval back", () => {
    triage(null);
    state.approval = { status: "ready", data: "approved", refetch };
    renderCard();
    const button = screen.getByRole("button", { name: /Approved/ });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(state.approvals).toEqual([{ taskId: TASK, approved: false }]);
  });

  it("pends while the decision is unknown — never a stand-in Approve", () => {
    triage(null);
    state.approval = { status: "loading", refetch };
    renderCard();
    const button = screen.getByRole("button", { name: /Approve/ });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(state.approvals).toEqual([]);
  });
});
