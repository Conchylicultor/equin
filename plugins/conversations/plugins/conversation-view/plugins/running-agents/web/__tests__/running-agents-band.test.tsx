import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import type {
  SubagentEntry,
  useConversationSubagents,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/web";
import type { WorkflowRunEntry } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/core";
import type {
  useConversationShells,
  useShellOutput,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/web";
import type { BackgroundShell } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/core";
import type { HostedToolbarParts } from "@plugins/primitives/plugins/data-view/core";
import { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import { RunningAgentsBand } from "../components/running-agents-band";

/**
 * The band over fixture sub-agents: what it says about them, what it shows for
 * one that just stopped, what it drops, and that the summary line folds it.
 *
 * Two seams are stubbed and nothing else. The sub-agent read, because this
 * suite is about the band and not about the join it deliberately does not do —
 * that lives in the subagents plugin, with its own tests. And the DataView,
 * down to "call the frame with the rows", because how rows draw is the
 * primitive's own tested behaviour: what is asserted here is the field schema
 * the band projects and the card it draws around them.
 */

type ConversationSubagents = ReturnType<typeof useConversationSubagents>;

/** What the stubbed sub-agent read answers on the next render. */
let subagents: ConversationSubagents = { kind: "pending" };

vi.mock(
  "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useConversationSubagents: () => subagents,
  }),
);

type ConversationShells = ReturnType<typeof useConversationShells>;

/** What the stubbed shell read answers on the next render. */
let shells: ConversationShells = { kind: "known", shells: [] };
/** The stubbed output tail, per shell id. */
let outputs: Record<string, ReturnType<typeof useShellOutput>> = {};

vi.mock(
  "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useConversationShells: () => shells,
    useShellOutput: (_conversationId: string | null, shellId: string) =>
      outputs[shellId] ?? {
        status: "loading",
        refetch: () => Promise.resolve(),
      },
  }),
);

/** The shape of `DataViewProps` this band actually uses. */
interface FakeDataViewProps {
  rows: readonly unknown[];
  fields: {
    id: string;
    value?: (row: never) => unknown;
    cell?: (row: never) => ReactNode;
  }[];
  rowKey: (row: never, index: number) => string;
  rowActivation?: (row: never) => (() => void) | undefined;
  toolbar?: { kind?: string; frame?: ComponentType<HostedToolbarParts> };
  viewOptions?: { list?: { leading?: (row: never) => ReactNode } };
}

// Partial: the rest of the barrel stays real, so a module this band reaches
// that builds a DataView source at load (the notifications pane, reached
// through another plugin's barrel) still evaluates.
vi.mock("@plugins/primitives/plugins/data-view/web", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<object>()),
    defineDataView: (id: string) => id,
    DataView: (props: FakeDataViewProps) => {
      const frame = props.toolbar?.frame;
      if (props.toolbar?.kind !== "hosted" || frame === undefined) {
        throw new Error("the band must draw its rows through a hosted frame");
      }
      const leading = props.viewOptions?.list?.leading;
      const body = createElement(
        "ul",
        { "data-testid": "rows" },
        props.rows.map((row, index) => {
          const key = props.rowKey(row as never, index);
          return createElement(
            "li",
            {
              key,
              "data-testid": `row:${key}`,
              "data-activates": String(
                props.rowActivation?.(row as never) !== undefined,
              ),
            },
            leading?.(row as never),
            ...props.fields.map((field) =>
              createElement(
                "span",
                { key: field.id, "data-testid": `cell:${key}:${field.id}` },
                field.cell
                  ? field.cell(row as never)
                  : String(field.value?.(row as never) ?? ""),
              ),
            ),
          );
        }),
      );
      return createElement(frame, {
        options: createElement("button", { type: "button" }, "View options"),
        switcher: null,
        creators: null,
        body,
        stickyRef: () => {},
      });
    },
  };
});

const plugin = {
  id: "conversations-running-agents-test",
  description: "running-agents band fixture",
  contributions: [],
} as unknown as LoadedPlugin;

const conversation = {
  id: "conv-1",
  status: "working",
} as unknown as ConversationRecord;

/** A fixed "now", so every duration below renders exactly one string. */
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000);

function entry(over: {
  id: string;
  agentType?: string;
  description?: string;
  model?: string;
  requestShape?: "background" | "foreground";
  startedAgo: number;
  state: SubagentEntry["state"];
  endedAgo?: number;
  lastStep?: SubagentEntry["lastStep"];
}): SubagentEntry {
  const lastStep: SubagentEntry["lastStep"] = over.lastStep ?? {
    kind: "tool",
    toolName: "Read",
    preview: "auth.ts",
  };
  return {
    row: {
      kind: "described",
      agentId: over.id,
      agentType: over.agentType ?? "Explore",
      description: over.description ?? "Search auth flow",
      toolUseId: `toolu_${over.id}`,
      model: over.model,
      requestShape: over.requestShape,
      startedAt: ago(over.startedAgo).toISOString(),
      lastActivityAt: ago(over.endedAgo ?? 0).toISOString(),
      turnEnded: false,
      newestTurnLineAt: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      lastStep,
    },
    state: over.state,
    startedAt: ago(over.startedAgo),
    endedAt: over.endedAgo === undefined ? null : ago(over.endedAgo),
    lastStep,
    agentToolEvent: undefined,
  };
}

const FIXTURES: SubagentEntry[] = [
  entry({
    id: "fg",
    agentType: "Explore",
    description: "Search auth flow",
    model: "sonnet",
    requestShape: "foreground",
    startedAgo: 74,
    state: { kind: "running" },
  }),
  entry({
    id: "bg",
    agentType: "Plan",
    description: "Design migration path",
    model: "opus",
    requestShape: "background",
    startedAgo: 246,
    state: { kind: "running" },
    lastStep: { kind: "thinking", preview: "weighing the order" },
  }),
  entry({
    id: "just-done",
    description: "Audit endpoint handlers",
    startedAgo: 130,
    state: { kind: "finished" },
    endedAgo: 1,
  }),
  entry({
    id: "ended",
    description: "Rewrite the docs index",
    startedAgo: 200,
    state: { kind: "ended-without-reporting" },
    endedAgo: 2,
  }),
  entry({
    id: "long-done",
    description: "Check hook syntax",
    startedAgo: 600,
    state: { kind: "finished" },
    endedAgo: 300,
  }),
];

const known = (
  entries: SubagentEntry[],
  workflowRuns: WorkflowRunEntry[] = [],
): ConversationSubagents => ({
  kind: "known",
  entries,
  workflowRuns,
  statusOf: () => ({ kind: "pending" }),
});

function renderBand() {
  return render(
    <PluginProvider plugins={[plugin]}>
      <RunningAgentsBand conversation={conversation} />
    </PluginProvider>,
  );
}

const summaryLine = () =>
  screen.getByRole("button", { name: "Running agents" });

beforeEach(() => {
  // The card's view (open, show all) is a per-conversation localStorage value;
  // one test folding the card must not fold it for the next.
  localStorage.clear();
  shells = { kind: "known", shells: [] };
  outputs = {};
  // Date only: the band's linger timer and the clocks' own ticks stay real, so
  // nothing here depends on advancing them.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the running-agents band", () => {
  it("shows nothing at all while the reads have not landed", () => {
    subagents = { kind: "pending" };
    expect(renderBand().container.innerHTML).toBe("");
  });

  it("says a failed read failed, with Retry — never an empty band", () => {
    const refetch = vi.fn(() => Promise.resolve());
    subagents = {
      kind: "failed",
      error: new ResourceError("loader-failed", "boom", undefined),
      refetch,
    };
    renderBand();
    expect(
      screen.getByText(/Couldn't load the running agents: boom/),
    ).toBeTruthy();
    act(() => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when no sub-agent is working", () => {
    subagents = known([]);
    expect(renderBand().container.innerHTML).toBe("");
  });

  it("counts what is working and clocks the longest of those", () => {
    subagents = known(FIXTURES);
    renderBand();

    // Two are running; the two that just stopped are shown but not counted.
    expect(summaryLine().textContent).toContain("2 agents working");
    expect(summaryLine().textContent).toContain("longest 4:06");
    expect(summaryLine().getAttribute("aria-expanded")).toBe("true");
  });

  it("lists every sub-agent still on screen, and drops the one whose linger is over", () => {
    subagents = known(FIXTURES);
    renderBand();

    expect(
      [...screen.getByTestId("rows").children].map((row) =>
        row.getAttribute("data-testid"),
      ),
    ).toEqual(["row:fg", "row:bg", "row:just-done", "row:ended"]);
  });

  it("says of each row what it is and what it last did", () => {
    subagents = known(FIXTURES);
    renderBand();

    // The task, then what it last did — one line, so the step is cut first.
    expect(screen.getByTestId("cell:fg:description").textContent).toBe(
      "Search auth flow · Read auth.ts",
    );
    expect(screen.getByTestId("cell:fg:type").textContent).toBe("Explore");
    expect(screen.getByTestId("cell:fg:model").textContent).toBe("sonnet");
    expect(screen.getByTestId("cell:fg:lastStep").textContent).toBe(
      "Read auth.ts",
    );
    // A foreground agent says nothing about where it runs; a background one does.
    expect(screen.getByTestId("cell:fg:background").textContent).toBe("");
    expect(screen.getByTestId("cell:bg:background").textContent).toBe(
      "background",
    );
    expect(screen.getByTestId("cell:bg:lastStep").textContent).toBe(
      "Thinking: weighing the order",
    );
  });

  it("shows a running row's clock, and how long a just-stopped one took", () => {
    subagents = known(FIXTURES);
    renderBand();

    expect(screen.getByTestId("cell:fg:started").textContent).toBe("1:14");
    // Both ways of stopping read the same: it is no longer working.
    expect(screen.getByTestId("cell:just-done:started").textContent).toBe(
      "done2:09",
    );
    expect(screen.getByTestId("cell:ended:started").textContent).toBe(
      "done3:18",
    );
  });

  it("folds the list from the summary line", () => {
    subagents = known(FIXTURES);
    renderBand();

    act(() => summaryLine().click());

    expect(screen.queryByTestId("rows")).toBeNull();
    expect(summaryLine().getAttribute("aria-expanded")).toBe("false");
    // The summary itself never leaves — it is what folds and unfolds the rows.
    expect(summaryLine().textContent).toContain("2 agents working");
  });

  it("draws a workflow run as the row its agents sit under, which opens nothing", () => {
    const agent = entry({
      id: "w1",
      description: "Review the router",
      startedAgo: 30,
      state: { kind: "running" },
    });
    subagents = known(
      [
        {
          ...agent,
          row: { ...agent.row, workflow: { runId: "wf_x", reported: false } },
        },
      ],
      [
        {
          runId: "wf_x",
          call: undefined,
          state: { kind: "running" },
          startedAt: ago(40),
          endedAt: null,
        },
      ],
    );
    renderBand();

    expect(
      [...screen.getByTestId("rows").children].map((row) => [
        row.getAttribute("data-testid"),
        row.getAttribute("data-activates"),
      ]),
    ).toEqual([
      ["row:workflow:wf_x", "false"],
      ["row:w1", "true"],
    ]);
    // A run has no transcript of its own, so its label is its name alone.
    expect(
      screen.getByTestId("cell:workflow:wf_x:description").textContent,
    ).toBe("wf_x");
    expect(screen.getByTestId("cell:workflow:wf_x:type").textContent).toBe(
      "workflow",
    );
    // One agent is working; the run it belongs to is not a second one.
    expect(summaryLine().textContent).toContain("1 agent working");
  });

  describe("background shells", () => {
    const shell = (
      id: string,
      over: Partial<BackgroundShell> = {},
    ): BackgroundShell => ({
      shellId: id,
      toolUseId: `toolu_${id}`,
      command: `npm run ${id}`,
      description: undefined,
      outputFile: `/private/tmp/claude-501/x/y/tasks/${id}.output`,
      startedAt: ago(100),
      endedAt: null,
      state: { kind: "running" },
      ...over,
    });
    const present = (tail: string): ReturnType<typeof useShellOutput> => ({
      status: "ready",
      data: { kind: "present", size: tail.length, tail, truncated: false },
      refetch: () => Promise.resolve(),
    });

    it("waits for the shells too before saying anything", () => {
      subagents = known([]);
      shells = { kind: "pending" };
      expect(renderBand().container.innerHTML).toBe("");
    });

    it("counts shells on their own when no agent is working", () => {
      subagents = known([]);
      shells = {
        kind: "known",
        shells: [shell("s1", { startedAt: ago(130) }), shell("s2")],
      };
      renderBand();
      expect(summaryLine().textContent).toContain("2 shells running");
      expect(summaryLine().textContent).not.toContain("agent");
      expect(summaryLine().textContent).toContain("longest 2:10");
    });

    it("counts agents and shells apart", () => {
      subagents = known(FIXTURES);
      shells = {
        kind: "known",
        shells: [shell("s1", { startedAt: ago(300) })],
      };
      renderBand();
      expect(summaryLine().textContent).toContain("2 agents · 1 shell running");
      expect(summaryLine().textContent).toContain("longest 5:00");
    });

    it("shows a shell's latest output line, and opens its output pane", () => {
      subagents = known([]);
      shells = {
        kind: "known",
        shells: [
          shell("s1", { description: "Build the app" }),
          shell("s2"),
          shell("s3"),
        ],
      };
      outputs = {
        s1: present("compiling\r 40%\r 80%\n"),
        s2: present(""),
      };
      renderBand();

      expect(screen.getByTestId("cell:shell:s1:description").textContent).toBe(
        "Build the app ·  80%",
      );
      expect(screen.getByTestId("cell:shell:s2:description").textContent).toBe(
        "npm run s2 · no output yet",
      );
      // Still landing: the task alone, never a guessed step.
      expect(screen.getByTestId("cell:shell:s3:description").textContent).toBe(
        "npm run s3",
      );
      expect(screen.getByTestId("cell:shell:s1:type").textContent).toBe(
        "shell",
      );
      expect(
        screen.getByTestId("row:shell:s1").getAttribute("data-activates"),
      ).toBe("true");
    });

    it("says how a just-ended shell ended", () => {
      subagents = known([]);
      shells = {
        kind: "known",
        shells: [
          shell("s1", {
            startedAt: ago(10),
            state: { kind: "failed", exitCode: 1 },
            endedAt: ago(1),
          }),
        ],
      };
      renderBand();
      expect(screen.getByTestId("cell:shell:s1:started").textContent).toBe(
        "Failed · exit 10:09",
      );
    });
  });
});
