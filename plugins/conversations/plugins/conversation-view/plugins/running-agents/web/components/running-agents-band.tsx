import { createContext, useContext, useMemo } from "react";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  FieldDef,
  HierarchyConfig,
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  CollapsibleChevron,
  FoldMotion,
  useCollapsible,
  type UseCollapsibleReturn,
} from "@plugins/primitives/plugins/collapsible/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  Fill,
  fillClasses,
} from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ElapsedTime } from "@plugins/primitives/plugins/relative-time/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { agentReportPane } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/agent/web";
import { formatTokenCount } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { SubagentDuration } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/web";
import { formatLastStep } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/core";
import {
  shellOutputPane,
  shellStateDisplay,
  useShellOutput,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/web";
import { lastOutputLine } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/core";
import {
  summarizeAgents,
  type RunningAgentRow,
  type RunningAgentsSummary,
  type ShellBandRow,
} from "../internal/agent-rows";
import { useRunningAgents } from "./use-running-agents";
import { useAgentsBandView } from "./band-view";
import "./running-agents-band.css";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkIcon = symbol("check");

const RUNNING_AGENTS_VIEW = defineDataView("running-agents");

const NO_ROWS: RunningAgentRow[] = [];

/**
 * What the card's own header shows — the half of the band that is NOT the
 * DataView's.
 *
 * It travels by context because the frame is a component declared at module
 * scope (a fresh identity each render would remount the whole card), and it
 * renders inside the DataView, below where the band holds this state.
 */
interface BandChrome {
  summary: RunningAgentsSummary;
  collapsible: UseCollapsibleReturn;
  /** The conversation whose shells' output the shell rows read. */
  conversationId: string;
  /** The card lists every agent (the transcript's agents stat asked for it). */
  showAll: boolean;
}

const BandChromeContext = createContext<BandChrome | null>(null);

function useBandChrome(): BandChrome {
  const chrome = useContext(BandChromeContext);
  if (chrome === null) {
    throw new Error("RunningAgentsCard renders only inside RunningAgentsBand");
  }
  return chrome;
}

/**
 * The marker that says work is still going: one small ring, turning.
 *
 * Held still under `prefers-reduced-motion` rather than removed, so the line
 * keeps the same shape for every reader (see the stylesheet beside this file).
 */
function ActivityRing() {
  return (
    <span
      aria-hidden
      className={cn("running-agents-ring size-3", rigidClass())}
    />
  );
}

/**
 * How a stopped row says it stopped: "done" for an agent or a run, and for a
 * shell the background-shells plugin's own label ("exit 0", "Failed · exit 1",
 * "Killed") — how a shell ended is the thing worth reading.
 */
function doneLabel(row: RunningAgentRow): string {
  return row.kind === "shell" ? shellStateDisplay(row.state).label : "done";
}

/** How long a row has been going, or — once it has stopped — how long it took. */
function ElapsedCell({ row }: { row: RunningAgentRow }) {
  const done = row.endedAt !== null;
  return (
    <Line as="span" className="gap-2xs text-muted-foreground">
      {done && <Icon icon={checkIcon} className={cn("size-3", rigidClass())} />}
      {done && <span>{doneLabel(row)}</span>}
      <SubagentDuration
        startedAt={row.startedAt}
        endedAt={row.endedAt}
        className="font-mono tabular-nums"
      />
    </Line>
  );
}

/**
 * What a row says it last did — `formatLastStep`, so a card phrases it the
 * same. `null` for a workflow run's row: a run writes no transcript of its
 * own, and what it is doing is what the agents under it say. `null` for a
 * shell's too: its last step is its latest output line, which is a live read
 * ({@link ShellLastLine}), not a field of the row.
 */
function lastStepText(row: RunningAgentRow): string | null {
  if (row.kind !== "agent") return null;
  return row.lastStep === null
    ? "Nothing written yet"
    : formatLastStep(row.lastStep);
}

/**
 * A shell's "last step": the latest line it printed (`lastOutputLine`, which
 * reads the latest `\r` frame of a progress bar), from the same live tail the
 * output pane streams — one subscription between them. Nothing while the tail
 * is landing: the task alone is true, a guessed step is not.
 */
function ShellLastLine({ row }: { row: ShellBandRow }) {
  const { conversationId } = useBandChrome();
  const output = useShellOutput(conversationId, row.shellId);
  const text = shellLastLineText(output);
  if (text === null) return null;
  return (
    <span className="text-muted-foreground">
      {" · "}
      {text}
    </span>
  );
}

function shellLastLineText(
  output: ReturnType<typeof useShellOutput>,
): string | null {
  switch (output.status) {
    case "loading":
      return null;
    case "error":
      return "output unavailable";
    case "ready":
      switch (output.data.kind) {
        case "present":
          return lastOutputLine(output.data.tail) ?? "no output yet";
        case "gone":
          return "output file gone";
        case "unknown-shell":
          return null;
      }
  }
}

/**
 * The row's label: what it was asked to do, then — muted — what it last did.
 *
 * One truncating line, and the order is the priority: when the row runs out of
 * room the last step is cut first and the task stays. It rides in the label
 * rather than in its own field because a tree row's other fields are rigid
 * chips that never shrink — a sentence there squeezes the task to nothing.
 * Plain inline spans only: a box of its own would take the truncation with it.
 */
function TaskLabel({ row }: { row: RunningAgentRow }) {
  if (row.kind === "shell") {
    return (
      <>
        {row.description}
        <ShellLastLine row={row} />
      </>
    );
  }
  const step = lastStepText(row);
  if (step === null) return <>{row.description}</>;
  return (
    <>
      {row.description}
      <span className="text-muted-foreground">
        {" · "}
        {step}
      </span>
    </>
  );
}

/**
 * The row schema. One line per sub-agent, nested under the one that spawned
 * it (or the workflow run that did): what it was asked to do and what it last
 * did are the label, what it is (type; model and where it runs a Properties
 * toggle away) sits after it, and its clock at the end. A run's row fills the
 * same columns with what a run has — its name, "workflow", its clock.
 */
const FIELDS: FieldDef<RunningAgentRow>[] = [
  {
    id: "description",
    label: "Task",
    type: "text",
    primary: true,
    value: (row) => row.description,
    cell: (row) => <TaskLabel row={row} />,
  },
  { id: "type", label: "Agent", type: "text", value: (row) => row.type },
  {
    id: "model",
    label: "Model",
    type: "text",
    value: (row) => (row.kind === "agent" ? row.model : null),
  },
  {
    id: "background",
    label: "Where it runs",
    type: "text",
    value: (row) =>
      row.kind === "agent" && row.background ? "background" : null,
  },
  {
    id: "lastStep",
    label: "Last step",
    type: "text",
    // Shown inside the label (`TaskLabel`); the field stays for search/filter.
    value: lastStepText,
  },
  {
    id: "tokens",
    label: "Output tokens",
    type: "number",
    align: "end",
    // A workflow run writes no transcript of its own, and a shell spends none.
    value: (row) => (row.kind === "agent" ? row.usage.output : null),
    cell: (row) =>
      row.kind === "agent" ? (
        <span
          className="font-mono tabular-nums text-muted-foreground"
          title={`${row.usage.output.toLocaleString()} output tokens`}
        >
          {formatTokenCount(row.usage.output)} out
        </span>
      ) : null,
  },
  {
    id: "started",
    label: "Started",
    type: "date",
    align: "end",
    value: (row) => row.startedAt,
    cell: (row) => <ElapsedCell row={row} />,
  },
];

/**
 * The band's card: a summary line that folds the list, and the list itself.
 *
 * This is the DataView's `frame`, so the options trigger it is handed (search,
 * filter, sort, fields — hover-revealed off the card) lands in the header where
 * a user looks for a list's controls, and the rows come back as `body`. Every
 * state renders through it, so the card does not reflow as the view's config
 * settles.
 */
function RunningAgentsCard({ options, switcher, body }: HostedToolbarParts) {
  const { summary, collapsible, showAll } = useBandChrome();
  const { open, triggerProps, contentProps } = collapsible;
  const working =
    summary.running > 0 || summary.shellsRunning > 0 || summary.runsGoing > 0;
  return (
    <Text as="div" variant="caption">
      <Clip className="rounded-md border border-border bg-muted/30">
        <Line className="gap-sm px-md py-sm">
          <Line
            as="button"
            {...triggerProps}
            aria-label="Running agents"
            className={cn(
              fillClasses("x"),
              "gap-sm text-left hover:bg-foreground/[0.03]",
            )}
          >
            {working ? (
              <ActivityRing />
            ) : (
              <Icon
                icon={checkIcon}
                className={cn("size-3 text-muted-foreground", rigidClass())}
              />
            )}
            <Fill as="span">
              {working &&
              summary.running === 0 &&
              summary.shellsRunning === 0 ? (
                // A run between phases: nothing to count, but not finished.
                <>
                  {summary.runsGoing === 1
                    ? "Workflow running"
                    : `${summary.runsGoing} workflows running`}
                  <span className="text-muted-foreground">
                    {" · between phases"}
                  </span>
                </>
              ) : working ? (
                <>
                  <WorkingCount summary={summary} />
                  {summary.longestSince !== null && (
                    <span className="text-muted-foreground">
                      {" · longest "}
                      <ElapsedTime
                        since={summary.longestSince}
                        className="font-mono tabular-nums"
                      />
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">
                  {showAll
                    ? `${summary.agents} ${summary.agents === 1 ? "agent" : "agents"} · all finished`
                    : "All finished"}
                </span>
              )}
            </Fill>
            <CollapsibleChevron
              open={open}
              className={cn("size-4 text-muted-foreground", rigidClass())}
            />
          </Line>
          {switcher}
          {options}
        </Line>
        <FoldMotion {...contentProps}>
          {/* Capped and scrolled on its own: a workflow can fan out into
              dozens of rows, and an unbounded list would push the prompt box
              below it off-screen with no way to reach it. */}
          <Scroll className="max-h-[40vh] rail-x-2xs border-t border-border/60 bg-background/40 py-2xs">
            {body}
          </Scroll>
        </FoldMotion>
      </Clip>
    </Text>
  );
}

/**
 * "2 agents working", "2 shells running", or both: "1 agent · 2 shells
 * running". Each kind is counted apart — a shell is not an agent working.
 */
function WorkingCount({ summary }: { summary: RunningAgentsSummary }) {
  const { running, shellsRunning } = summary;
  const agents = running === 1 ? " agent" : " agents";
  const shells = (
    <>
      <span className="font-medium">{shellsRunning}</span>
      {shellsRunning === 1 ? " shell running" : " shells running"}
    </>
  );
  if (shellsRunning === 0) {
    return (
      <>
        <span className="font-medium">{running}</span>
        {agents} working
      </>
    );
  }
  if (running === 0) return shells;
  return (
    <>
      <span className="font-medium">{running}</span>
      {agents}
      {" · "}
      {shells}
    </>
  );
}

const BAND_TOOLBAR: HostedToolbar = {
  kind: "hosted",
  frame: RunningAgentsCard,
};

/**
 * The sub-agents working for this conversation, above the prompt box.
 *
 * Its own box, stacking with the op-status banner and the turn summary — not
 * fused into the composer's border, which belongs to what the user is typing.
 *
 * There is deliberately **no stop button**. The app drives Claude Code by
 * typing into its terminal, and the only stop that has is Escape, which
 * interrupts the whole turn; a single sub-agent cannot be stopped from here, so
 * a control on one row would be a lie about what pressing it does.
 *
 * Nothing renders until the reads have landed, and nothing renders when no
 * sub-agent is working: an empty band would be a claim, and chrome around
 * nothing is worse than no band. A failed read renders the failure with Retry.
 */
export function RunningAgentsBand({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  // Shared with the transcript's agents stat, which toggles `showAll`.
  const { view, setOpen } = useAgentsBandView(conversation.id);
  const state = useRunningAgents(conversation.id, view.showAll);
  const openPane = useOpenPane();
  const collapsible = useCollapsible({
    open: view.open,
    onOpenChange: setOpen,
  });

  const rows = state.kind === "known" ? state.rows : NO_ROWS;
  const chrome = useMemo<BandChrome>(
    () => ({
      summary: summarizeAgents(rows),
      collapsible,
      conversationId: conversation.id,
      showAll: view.showAll,
    }),
    [rows, collapsible, conversation.id, view.showAll],
  );
  // Each sub-agent sits under the one that spawned it. Siblings keep launch
  // order: the rows arrive in start order, and their ranks are minted from that
  // order, so nothing here can reorder them — and there is no `onMove`, so
  // nobody can drag them either.
  const hierarchy = useMemo<HierarchyConfig<RunningAgentRow>>(() => {
    const ranks = new Map(
      Rank.nBetween(null, null, rows.length).map((rank, i) => [
        rows[i]!.key,
        rank,
      ]),
    );
    return {
      getParentId: (row) => row.parentKey,
      getRank: (row) => ranks.get(row.key)!,
    };
  }, [rows]);

  if (state.kind === "pending") return null;
  // A failed read is not "nothing working": say so, with Retry, in the band's
  // own place above the prompt box.
  if (state.kind === "failed")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the running agents"
        error={state.error}
        refetch={state.refetch}
      />
    );
  if (rows.length === 0) return null;

  return (
    <BandChromeContext.Provider value={chrome}>
      <DataView<RunningAgentRow>
        rows={rows}
        fields={FIELDS}
        rowKey={(row) => row.key}
        views={["table"]}
        hierarchy={hierarchy}
        density="compact"
        storageKey={RUNNING_AGENTS_VIEW}
        searchPlaceholder="Search agents"
        toolbar={BAND_TOOLBAR}
        searchAccessor={(row) => `${row.description} ${row.type}`}
        // An agent row opens the same report pane its transcript card does,
        // by the sub-agent's own id — the one key every sub-agent has,
        // including a teammate another sub-agent spawned, whose launching call
        // is nowhere in this conversation's transcript. A workflow run's row
        // opens nothing: there is no pane for a whole run (its transcript card
        // already draws the DAG), so folding is its only interaction.
        // A shell row opens its live output pane.
        rowActivation={(row) => {
          switch (row.kind) {
            case "agent":
              return openPane.to(
                agentReportPane,
                { by: "agent", key: row.key },
                { mode: "push" },
              );
            case "shell":
              return openPane.to(
                shellOutputPane,
                { shellId: row.shellId },
                { mode: "push" },
              );
            case "workflow":
              return undefined;
          }
        }}
        emptyState={
          <Text tone="muted">No agent matches what you searched for.</Text>
        }
        viewOptions={{
          table: {
            // The band exists to show the whole set; a user fold still wins.
            defaultExpanded: true,
            leadingIcon: (row: RunningAgentRow) => (
              <StatusDot
                colorClass={
                  row.state.kind === "running"
                    ? "bg-muted-foreground"
                    : "bg-muted-foreground/40"
                }
              />
            ),
          },
        }}
      />
    </BandChromeContext.Provider>
  );
}
