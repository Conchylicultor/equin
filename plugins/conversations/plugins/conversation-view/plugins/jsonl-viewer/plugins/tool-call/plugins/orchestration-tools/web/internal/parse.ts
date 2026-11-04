import {
  TaskStatusSchema,
  type TaskStatus,
} from "@plugins/tasks/plugins/tasks-core/core";

// The orchestration tools answer in plain text, written for the agent (tasks'
// manage-tasks, message's send / agents, tree-digest's digest). These readers
// recover the facts a transcript row draws from it; a line they cannot read is
// kept as text, so a format change shows up as raw lines, never as nothing.

/** `edit_task` / `drop_task`: "Refused: …" is a refusal, any other answer the
 *  change made. */
export type ManageAnswer =
  { kind: "done" } | { kind: "refused"; message: string };

export function readManageAnswer(content: string): ManageAnswer {
  const refused = /^Refused: ([\s\S]*)$/.exec(content);
  return refused ? { kind: "refused", message: refused[1]! } : { kind: "done" };
}

/** `message_agent`'s answer: where the message went and how it lands. */
export type MessageAnswer =
  | { kind: "sent"; conversationId: string; delivery: string }
  | { kind: "not-sent"; message: string }
  | { kind: "unread"; text: string };

export function readMessageAnswer(content: string): MessageAnswer {
  const notSent = /^Not sent: ([\s\S]*)$/.exec(content);
  if (notSent) return { kind: "not-sent", message: notSent[1]! };
  const sent = /^Sent to (\S+): ([\s\S]*)$/.exec(content);
  if (!sent) return { kind: "unread", text: content };
  const delivery = sent[2]!;
  return {
    kind: "sent",
    conversationId: sent[1]!,
    delivery: delivery.charAt(0).toUpperCase() + delivery.slice(1),
  };
}

/** One task line of `task_tree` (and of the digest `add_task` appends). */
export type TreeLine =
  | {
      kind: "task";
      depth: number;
      taskId: string;
      title: string;
      /** Null when the first word is not a known status. */
      status: TaskStatus | null;
      /** The annotations after the status (track, armed / manual, report…),
       *  "your task" taken out. */
      words: string[];
      self: boolean;
    }
  | { kind: "text"; text: string };

export interface TaskTree {
  rootTaskId: string | null;
  lines: TreeLine[];
}

const TREE_HEADER = /^Your task tree \(root (\S+)\):$/;
const TREE_LINE = /^((?: {2})*)- (\S+) ("(?:[^"\\]|\\.)*") — (.*)$/;

export function readTaskTree(content: string): TaskTree {
  const [first = "", ...rest] = content.split("\n");
  const header = TREE_HEADER.exec(first);
  const body = header ? rest : [first, ...rest];
  return {
    rootTaskId: header ? header[1]! : null,
    lines: body.filter((l) => l.trim() !== "").map(readTreeLine),
  };
}

function readTreeLine(line: string): TreeLine {
  const m = TREE_LINE.exec(line);
  if (!m) return { kind: "text", text: line.trim() };
  const title = parseQuoted(m[3]!);
  if (title === null) return { kind: "text", text: line.trim() };
  const [first = "", ...others] = m[4]!.split(", ");
  const status = TaskStatusSchema.safeParse(first);
  const words = status.success ? others : [first, ...others];
  return {
    kind: "task",
    depth: m[1]!.length / 2,
    taskId: m[2]!,
    title,
    status: status.success ? status.data : null,
    words: words.filter((w) => w !== "your task"),
    self: words.includes("your task"),
  };
}

function parseQuoted(quoted: string): string | null {
  try {
    const value: unknown = JSON.parse(quoted);
    return typeof value === "string" ? value : null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

/** One agent line of `list_agents`. */
export type AgentLine =
  | {
      kind: "agent";
      taskId: string;
      title: string;
      conversationId: string;
      /** How it stands: starting, working, idle, waiting on the user, … */
      standing: string;
      self: boolean;
    }
  | { kind: "text"; text: string };

// The title is written unquoted-inside-quotes, so it may hold a `"`: the
// conversation id after the LAST `" · ` closes it.
const AGENT_LINE = /^- (\S+) "(.*)" · ((?:conv|claude)-\S+) · (.*)$/;

export function readAgents(content: string): AgentLine[] {
  return content
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line): AgentLine => {
      const m = AGENT_LINE.exec(line);
      if (!m) return { kind: "text", text: line.trim() };
      const rest = m[4]!;
      const self = rest.endsWith(" · you");
      return {
        kind: "agent",
        taskId: m[1]!,
        title: m[2]!,
        conversationId: m[3]!,
        standing: self ? rest.slice(0, -" · you".length) : rest,
        self,
      };
    });
}
