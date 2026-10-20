import type { ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  JsonlViewer,
  TranscriptView,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import {
  subagentReport,
  subagentTranscript,
  type SubagentRef,
  type SubagentReport,
  type SubagentRequestShape,
  type SubagentTranscript,
} from "../../core";
import {
  useConversationSubagents,
  type ConversationSubagents,
  type SubagentStatus,
} from "../internal/use-subagent-statuses";
import { subagentStateDisplay } from "../internal/run-state-display";
import { SubagentDuration } from "./subagent-duration";
import { SubagentLastStep } from "./subagent-last-step";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const articleIcon = symbol("article");

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;
type ReportText = Extract<SubagentReport, { kind: "report" }>;

/**
 * What the parent's own `Agent` call said about the sub-agent it was launching.
 *
 * Only a FALLBACK: the meta file is authoritative and arrives within a second.
 * Read field by field rather than cast, so a harness that stops writing one of
 * them degrades to "not stated" instead of to a lie typed as a string.
 */
function readAgentInput(input: unknown): {
  agentType?: string;
  model?: string;
  description?: string;
} {
  if (typeof input !== "object" || input === null) return {};
  const record = input as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    agentType: text(record.subagent_type),
    model: text(record.model),
    description: text(record.description),
  };
}

/**
 * The sub-agent a ref names, as the pane reads it: how it is going, and the
 * parent's `Agent` call that launched it when the parent transcript holds one.
 *
 * `missing` is only reachable by agent id — a row that is no longer on disk. By
 * call there is always an answer: no row yet is "starting", which the status
 * already expresses.
 */
type ResolvedRef =
  | {
      kind: "known";
      status: SubagentStatus;
      agentToolEvent: ToolCallEvent | undefined;
    }
  | { kind: "missing" };

function resolveRef(
  subagents: ConversationSubagents,
  ref: SubagentRef,
): ResolvedRef {
  if (ref.by === "call") {
    const agentToolEvent =
      subagents.kind === "known"
        ? subagents.agentCalls.find((c) => c.toolUseId === ref.key)
        : undefined;
    return {
      kind: "known",
      agentToolEvent,
      status:
        subagents.kind === "known"
          ? subagents.statusOf({ toolUseId: ref.key, agentToolEvent })
          : subagents,
    };
  }
  if (subagents.kind === "pending" || subagents.kind === "failed") {
    return { kind: "known", status: subagents, agentToolEvent: undefined };
  }
  const entry = subagents.entries.find((e) => e.row.agentId === ref.key);
  if (entry === undefined) return { kind: "missing" };
  return {
    kind: "known",
    agentToolEvent: entry.agentToolEvent,
    status: {
      kind: "known",
      state: entry.state,
      row: entry.row.kind === "described" ? entry.row : undefined,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
    },
  };
}

/** The whole pane, when there is nothing to show in it yet. */
function PaneMessage({ children }: { children: ReactNode }) {
  return (
    <Stack gap="none" className="h-full min-h-0">
      <BodyMessage>{children}</BodyMessage>
    </Stack>
  );
}

/** A flex-fill body region, for the arms that are not the transcript itself. */
function BodyMessage({ children }: { children: ReactNode }) {
  return (
    <Scroll axis="y" fill>
      <Stack gap="none" className="px-md py-sm">
        {children}
      </Stack>
    </Scroll>
  );
}

function SubagentHeader({
  agentType,
  model,
  description,
  status,
  isError,
}: {
  /** Every reading here is optional on purpose: the meta file's field set has
   *  grown across harness versions, so an absent one means nothing on disk
   *  recorded it. The header omits the chip rather than inventing a value. */
  agentType: string | undefined;
  model: string | undefined;
  description: string | undefined;
  status: SubagentStatus;
  isError: boolean;
}) {
  const display =
    status.kind === "known"
      ? subagentStateDisplay(status.state, { isError })
      : null;
  return (
    <Stack
      gap="2xs"
      className={cn(rigidClass(), "border-b border-border/60 px-md py-sm")}
    >
      <Line className="gap-sm">
        {agentType && (
          <Badge
            colorClass="bg-categorical-6/15 text-categorical-6"
            className={cn(rigidClass(), "font-mono")}
          >
            {agentType}
          </Badge>
        )}
        {model && (
          <Badge variant="muted" className={cn(rigidClass(), "font-mono")}>
            {model}
          </Badge>
        )}
        {display && (
          <Badge variant={display.variant} className={rigidClass()}>
            {display.label}
          </Badge>
        )}
        <Fill>
          <Text className="text-muted-foreground">{description}</Text>
        </Fill>
        {status.kind === "known" && (
          <SubagentDuration
            startedAt={status.startedAt}
            endedAt={status.endedAt}
            className={cn(
              rigidClass(),
              "font-mono tabular-nums text-muted-foreground",
            )}
          />
        )}
      </Line>
      {status.kind === "known" && (
        <SubagentLastStep row={status.row} state={status.state} />
      )}
    </Stack>
  );
}

/**
 * The sub-agent's write-up, when one can be recovered.
 *
 * Capped and scrolled rather than allowed to fill the pane: the report is the
 * summary, and the transcript below it is the working it came from — a long
 * report must not push the working off screen.
 */
function ReportCard({ report }: { report: ReportText }) {
  return (
    <CollapsibleCard
      icon={<Icon icon={articleIcon} className="size-3.5" />}
      label={report.isError ? "Error" : "Report"}
      error={report.isError}
      defaultOpen
    >
      <Scroll axis="both" className="max-h-80 px-md py-sm">
        {report.isError ? (
          <Text
            as="pre"
            variant="caption"
            className="whitespace-pre-wrap break-words text-destructive"
          >
            {report.text}
          </Text>
        ) : (
          <div className="prose-xs text-caption">
            <Markdown>{report.text}</Markdown>
          </div>
        )}
      </Scroll>
    </CollapsibleCard>
  );
}

/**
 * The report card, or nothing — and "nothing" is the common, correct answer.
 *
 * The write-up's source differs per request shape (`subagentReport`), and for a
 * BACKGROUND sub-agent it lives in the sub-agent's own transcript, so no
 * decision can be made until that has arrived. Rendering nothing meanwhile is
 * honest rather than lossy: this card is an enrichment above a transcript that
 * is already on screen and already contains the handback.
 */
function SubagentReportCard({
  requestShape,
  agentToolEvent,
  transcript,
  finished,
}: {
  requestShape: SubagentRequestShape | undefined;
  agentToolEvent: ToolCallEvent | undefined;
  transcript: ResourceResult<SubagentTranscript>;
  /** Only a finished sub-agent has handed anything back. */
  finished: boolean;
}) {
  // A failed transcript read is rendered once, by the transcript body below.
  if (!finished || transcript.status === "loading") return null;
  if (transcript.status === "error") return null;
  const report = subagentReport({
    requestShape,
    agentToolEvent,
    // Past the gate, `unlinked` means the sub-agent really wrote no transcript
    // — so there is no handback in it, which is what an empty list says here.
    events: transcript.data.kind === "linked" ? transcript.data.events : [],
  });
  if (report.kind === "none") return null;
  return (
    <Inset pad="sm" className={rigidClass()}>
      <ReportCard report={report} />
    </Inset>
  );
}

/**
 * One sub-agent, as its own surface: who it is and how it is going, the
 * write-up when there is one, and its live transcript below — drawn by
 * `TranscriptView`, the same component the conversation draws itself with, so
 * the cards here ARE the conversation's cards rather than a second set that
 * happens to look similar.
 *
 * Owned here rather than by the `agent` tool renderer that routes to it: the
 * pane is about the sub-agent, and the `agent` plugin keeps only the route.
 */
export function SubagentPaneBody({
  conversationId,
  subagent,
}: {
  /** The PARENT conversation — what both resources are keyed by. */
  conversationId: string;
  /** Which sub-agent: by the call that launched it, or by its own id. */
  subagent: SubagentRef;
}) {
  const subagents = useConversationSubagents(conversationId);
  // The parent's `Agent` calls (read over the WHOLE parent transcript, served
  // with the sub-agent set) are gated HERE, so that below this line a missing
  // `Agent` event means the parent really has not recorded one — never "it has
  // not arrived yet". Everything the pane says about the sub-agent is derived
  // from that event, so the distinction decides whether the header, the state
  // and the report are readings or guesses.
  if (subagents.kind === "failed") {
    return (
      <PaneMessage>
        <ResourceErrorInline
          variant="block"
          subject="the sub-agents"
          error={subagents.error}
          refetch={subagents.refetch}
        />
      </PaneMessage>
    );
  }
  if (subagents.kind === "pending") {
    return (
      <PaneMessage>
        <Loading />
      </PaneMessage>
    );
  }
  return (
    <SubagentPaneContent
      conversationId={conversationId}
      subagent={subagent}
      subagents={subagents}
    />
  );
}

function SubagentPaneContent({
  conversationId,
  subagent,
  subagents,
}: {
  conversationId: string;
  subagent: SubagentRef;
  /** The sub-agent set, already arrived. */
  subagents: Extract<ConversationSubagents, { kind: "known" }>;
}) {
  const resolved = resolveRef(subagents, subagent);
  const transcript = useLive(subagentTranscript, {
    id: conversationId,
    ...subagent,
  });

  if (resolved.kind === "missing") {
    return (
      <PaneMessage>
        <Text as="div" variant="caption" className="text-muted-foreground">
          This conversation has no sub-agent with that id any more.
        </Text>
      </PaneMessage>
    );
  }
  const { status, agentToolEvent } = resolved;

  const fallback = readAgentInput(agentToolEvent?.input);
  const row = status.kind === "known" ? status.row : undefined;
  const result = agentToolEvent?.result;
  // An `Agent` call that names no type ran a general-purpose agent — that is
  // the tool's documented default, so it is a fact about the call, not a
  // stand-in. With no call recorded at all, nothing says what this was.
  const calledType = agentToolEvent
    ? (fallback.agentType ?? "general-purpose")
    : undefined;
  const finished = status.kind === "known" && status.state.kind === "finished";

  return (
    // The flex column TranscriptView expects to be the growing child of —
    // same shape as the conversation pane.
    <Stack gap="none" className="h-full min-h-0">
      <SubagentHeader
        agentType={row?.agentType ?? calledType}
        model={row?.model ?? fallback.model}
        description={row?.description ?? fallback.description}
        status={status}
        isError={result?.isError === true}
      />
      <SubagentReportCard
        requestShape={row?.requestShape}
        agentToolEvent={agentToolEvent}
        transcript={transcript}
        finished={finished}
      />
      <SubagentTranscript
        conversationId={conversationId}
        subagent={subagent}
        transcript={transcript}
        status={status}
      />
    </Stack>
  );
}

function SubagentTranscript({
  conversationId,
  subagent,
  transcript,
  status,
}: {
  conversationId: string;
  subagent: SubagentRef;
  transcript: ResourceResult<SubagentTranscript>;
  status: SubagentStatus;
}) {
  if (transcript.status === "loading") {
    return (
      <BodyMessage>
        <Loading />
      </BodyMessage>
    );
  }
  if (transcript.status === "error") {
    return (
      <BodyMessage>
        <ResourceErrorInline
          variant="block"
          subject="the sub-agent transcript"
          error={transcript.error}
          refetch={transcript.refetch}
        />
      </BodyMessage>
    );
  }
  if (transcript.data.kind === "unjoinable") {
    // A sub-agent exists, but nothing can prove it is THIS card's. Permanent —
    // unlike `unlinked`, no later append resolves it — so the pane says what is
    // wrong instead of spinning forever on something that is never coming.
    return (
      <BodyMessage>
        <Text as="div" variant="caption" className="text-muted-foreground">
          {transcript.data.reason}
        </Text>
      </BodyMessage>
    );
  }
  if (transcript.data.kind === "unlinked") {
    // No file claimed by this ref. While the sub-agent is still going
    // that is "not written yet"; once it has stopped, no file is ever coming —
    // and a spinner that spins forever is the lie the discriminated result
    // exists to prevent.
    const stopped = status.kind === "known" && status.state.kind !== "running";
    return (
      <BodyMessage>
        {stopped ? (
          <Text as="div" variant="caption" className="text-muted-foreground">
            This sub-agent left no transcript.
          </Text>
        ) : (
          <Loading
            variant="spinner"
            label="Waiting for the sub-agent's first lines…"
          />
        )}
      </BodyMessage>
    );
  }
  return (
    <TranscriptView
      events={transcript.data.events}
      conversationId={conversationId}
      subject={{ kind: "subagent", agentId: transcript.data.agentId }}
      // The surface tab is appended by the view — name only the subject here.
      persistKey={`subagent-scroll:${subagent.by}:${subagent.key}`}
      empty={
        <Text as="div" variant="caption" tone="muted">
          This sub-agent&apos;s transcript is empty so far.
        </Text>
      }
      // The same pinned readings the conversation carries (token usage, the
      // outline, task progress). Overlays fold over the transcript the view
      // draws, so here they report the sub-agent's own numbers.
      overlay={<JsonlViewer.Overlay.Render />}
    />
  );
}
