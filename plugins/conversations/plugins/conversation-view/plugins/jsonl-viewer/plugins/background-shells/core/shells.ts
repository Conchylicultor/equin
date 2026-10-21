import {
  taskStopTimes,
  type JsonlEvent,
} from "@plugins/conversations/plugins/transcript-source/core";
import { hasLiveProcess } from "@plugins/conversations/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;
type TaskNotificationEvent = Extract<JsonlEvent, { kind: "task-notification" }>;

/** The tool name Claude Code gives a shell command in a transcript. */
export const BASH_TOOL_NAME = "Bash";

/**
 * Where a background shell stands, as far as the transcript can honestly say.
 *
 * - `completed` / `failed` / `killed` — Claude Code's own `<task-notification>`
 *   said so. `exitCode` is read from its summary's `(exit code N)` and is
 *   `null` when the summary does not state one.
 * - `killed` is also what a successful `TaskStop` of the shell says: Claude
 *   Code writes NO notification for a shell the agent stopped itself, so
 *   without it the shell would read `running` for as long as the conversation
 *   lives.
 * - `ended-unrecognized` — a notification arrived, so the shell is over, but
 *   with a `status` this build has never seen. Named rather than folded into
 *   `failed`: the transcript says it ended, and nothing says how.
 * - `ended-without-reporting` — no notification, and the conversation is no
 *   longer live. Claude Code kills its shells when it exits, so nothing is
 *   hosting it any more. The same parent-liveness evidence `subagentRunState`
 *   uses, and deliberately NO staleness timeout: a quiet shell may be one long
 *   `sleep`.
 */
export type BackgroundShellState =
  | { kind: "running" }
  | { kind: "completed"; exitCode: number | null }
  | { kind: "failed"; exitCode: number | null }
  | { kind: "killed" }
  | { kind: "ended-unrecognized"; status: string; exitCode: number | null }
  | { kind: "ended-without-reporting" };

/** What one background `Bash` launch recorded, before its state is decided. */
export interface ShellLaunch {
  /** The id Claude Code minted for it (`Command running in background with ID: <id>`). */
  shellId: string;
  /** The launching `Bash` call's tool-use id. */
  toolUseId: string;
  command: string;
  /** The call's `description`, when the agent gave one. */
  description?: string;
  /** Absolute path of the file the shell's stdout/stderr is written to. */
  outputFile: string;
  /** The launching call's time. */
  startedAt: Date;
}

/** One background shell of a conversation. */
export interface BackgroundShell extends ShellLaunch {
  state: BackgroundShellState;
  /**
   * When the completion notification arrived. `null` while running, and for
   * `ended-without-reporting` — nothing on record says when it stopped.
   */
  endedAt: Date | null;
}

export interface BackgroundShellsInput {
  events: readonly JsonlEvent[];
  /** The conversation's status — the liveness evidence for a shell with no notification. */
  conversationStatus: ConversationStatus;
}

/**
 * The launch acknowledgement Claude Code writes as a background `Bash` call's
 * `tool_result`:
 *
 * `Command running in background with ID: <id>. Output is being written to: <path>. You will be notified…`
 *
 * The id is `[A-Za-z0-9]+` (measured: 9 lowercase alphanumerics); the path is
 * everything up to the `.output` that ends it.
 */
const ACK_PATTERN =
  /Command running in background with ID: ([A-Za-z0-9]+)\. Output is being written to: (\S(?:.*?\S)?\.output)(?=\.|\s|$)/;

/** A shell id as Claude Code mints it — also what the server checks a subscription's id against. */
export const SHELL_ID_PATTERN = /^[A-Za-z0-9]+$/;

/**
 * The shell id and output path a launch acknowledgement names, or `null` when
 * `content` is not one (a launch that failed, or a harness that changed its
 * wording — both render as the plain card, never as a shell).
 */
export function parseShellAck(
  content: string,
): { shellId: string; outputFile: string } | null {
  const match = ACK_PATTERN.exec(content);
  if (!match) return null;
  return { shellId: match[1]!, outputFile: match[2]! };
}

/** The `(exit code N)` a completion notification's summary states, else `null`. */
export function exitCodeOfSummary(summary: string): number | null {
  const match = /\(exit code (-?\d+)\)/.exec(summary);
  return match ? Number(match[1]) : null;
}

function readInput(input: unknown): {
  background: boolean;
  command: string | undefined;
  description?: string;
} {
  if (typeof input !== "object" || input === null) {
    return { background: false, command: undefined, description: undefined };
  }
  const record = input as Record<string, unknown>;
  const text = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;
  return {
    background: record.run_in_background === true,
    command: typeof record.command === "string" ? record.command : undefined,
    description: text(record.description),
  };
}

/**
 * The shell a background `Bash` call launched, or `null` when it launched none:
 * not a `Bash` call, not backgrounded, no result yet, or a result that is not
 * the launch acknowledgement (a failed launch).
 */
export function shellLaunchOf(event: ToolCallEvent): ShellLaunch | null {
  if (event.name !== BASH_TOOL_NAME) return null;
  const input = readInput(event.input);
  if (!input.background || input.command === undefined) return null;
  if (event.result === undefined || event.result.isError === true) return null;
  const ack = parseShellAck(event.result.content);
  if (ack === null) return null;
  return {
    shellId: ack.shellId,
    toolUseId: event.toolUseId,
    command: input.command,
    description: input.description,
    outputFile: ack.outputFile,
    startedAt: new Date(event.at),
  };
}

/** Every background shell launch in a transcript, in start order. */
export function shellLaunchesIn(events: readonly JsonlEvent[]): ShellLaunch[] {
  const launches: ShellLaunch[] = [];
  for (const event of events) {
    if (event.kind !== "tool-call") continue;
    const launch = shellLaunchOf(event);
    if (launch !== null) launches.push(launch);
  }
  return launches;
}

function stateOfNotification(
  notification: TaskNotificationEvent,
): BackgroundShellState {
  const exitCode = exitCodeOfSummary(notification.summary);
  switch (notification.status) {
    case "completed":
      return { kind: "completed", exitCode };
    case "failed":
      return { kind: "failed", exitCode };
    case "killed":
      return { kind: "killed" };
    default:
      return {
        kind: "ended-unrecognized",
        status: notification.status,
        exitCode,
      };
  }
}

/**
 * What a transcript says about one background shell, before the conversation's
 * liveness is applied — the part derivable from the transcript alone, so the
 * server can fold it over the WHOLE transcript and push only this. Times are
 * ISO strings (the wire form of a `Date`).
 *
 * `end` is `null` when the transcript records no end (no notification, no
 * `TaskStop`): whether such a shell is `running` or `ended-without-reporting`
 * is decided by {@link shellsFromFacts} from the conversation's status.
 */
export interface ShellFact {
  shellId: string;
  toolUseId: string;
  command: string;
  description?: string;
  outputFile: string;
  startedAt: string;
  end: { state: BackgroundShellState; endedAt: string } | null;
}

/** The transcript half of {@link backgroundShellsOf}: every shell's launch and recorded end. */
export function shellFactsOf(events: readonly JsonlEvent[]): ShellFact[] {
  const byTaskId = new Map<string, TaskNotificationEvent>();
  const byToolUseId = new Map<string, TaskNotificationEvent>();
  for (const event of events) {
    if (event.kind !== "task-notification") continue;
    // First wins: a shell ends once.
    if (!byTaskId.has(event.taskId)) byTaskId.set(event.taskId, event);
    if (event.toolUseId !== undefined && !byToolUseId.has(event.toolUseId)) {
      byToolUseId.set(event.toolUseId, event);
    }
  }
  const stops = taskStopTimes(events);

  return shellLaunchesIn(events).map((launch): ShellFact => {
    const base = { ...launch, startedAt: launch.startedAt.toISOString() };
    const notification =
      byTaskId.get(launch.shellId) ?? byToolUseId.get(launch.toolUseId);
    if (notification !== undefined) {
      return {
        ...base,
        end: {
          state: stateOfNotification(notification),
          endedAt: new Date(notification.at).toISOString(),
        },
      };
    }
    const stoppedAt = stops.get(launch.shellId);
    if (stoppedAt !== undefined) {
      return {
        ...base,
        end: { state: { kind: "killed" }, endedAt: stoppedAt.toISOString() },
      };
    }
    return { ...base, end: null };
  });
}

/** The conversation half: decide a shell with no recorded end from the conversation's liveness. */
export function shellsFromFacts(
  facts: readonly ShellFact[],
  conversationStatus: ConversationStatus,
): BackgroundShell[] {
  const live = hasLiveProcess(conversationStatus);
  return facts.map(({ end, startedAt, ...launch }): BackgroundShell => {
    const started = { ...launch, startedAt: new Date(startedAt) };
    if (end !== null) {
      return { ...started, state: end.state, endedAt: new Date(end.endedAt) };
    }
    return {
      ...started,
      state: live ? { kind: "running" } : { kind: "ended-without-reporting" },
      endedAt: null,
    };
  });
}

/**
 * Every background shell of a conversation, in start order, with its state —
 * the ONE fold every surface (band row, `Bash` card, output pane) reads, so
 * they cannot disagree.
 *
 * A launch is a `Bash` call with `run_in_background: true` whose result is the
 * launch acknowledgement. Its end is the `task-notification` whose `taskId` is
 * the shell id (falling back to the notification's `toolUseId`, for a harness
 * that names the task differently), else a successful `TaskStop` of the shell
 * (`killed`, which Claude Code does not notify). With neither, the
 * conversation's own liveness decides between `running` and
 * `ended-without-reporting`.
 */
export function backgroundShellsOf({
  events,
  conversationStatus,
}: BackgroundShellsInput): BackgroundShell[] {
  return shellsFromFacts(shellFactsOf(events), conversationStatus);
}
