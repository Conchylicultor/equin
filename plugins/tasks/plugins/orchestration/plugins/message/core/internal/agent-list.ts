/**
 * The text of `list_agents`' answer, written by the tool and read back by the
 * transcript viewer, from this one place so the two cannot drift. A line the
 * reader does not recognise stays text.
 */

/** One agent of the tree, as its line says it. */
export interface AgentLine {
  taskId: string;
  title: string;
  conversationId: string;
  /** How it stands, in words: starting, working, idle, waiting on the user,
   *  stopped, closed — possibly followed by ` (…)` or ` · …` detail. */
  standing: string;
  /** The reading agent's own conversation. */
  self: boolean;
}

const SELF_SUFFIX = " · you";

export function formatAgentLine(a: AgentLine): string {
  return `- ${a.taskId} "${a.title}" · ${a.conversationId} · ${a.standing}${a.self ? SELF_SUFFIX : ""}`;
}

/** The whole answer: one line per agent shown, then how many settled agents
 * it left out and how many tasks no agent ran on. */
export function formatAgentList(
  agents: readonly AgentLine[],
  { notYetRun, hiddenSettled }: { notYetRun: number; hiddenSettled: number },
): string {
  if (agents.length === 0 && hiddenSettled === 0)
    return "No agent has run on a task of this tree yet.";
  const tail = [
    hiddenSettled > 0
      ? `+${hiddenSettled} older settled agent${hiddenSettled === 1 ? "" : "s"} (task done or dropped, or agent closed) not shown — \`list_agents({ all: true })\` lists them.`
      : null,
    notYetRun > 0
      ? `${notYetRun} task${notYetRun === 1 ? "" : "s"} no agent ran on yet (see \`task_tree\`).`
      : null,
  ].filter((l) => l !== null);
  return [agents.map(formatAgentLine).join("\n"), ...tail]
    .filter((l) => l !== "")
    .join("\n\n");
}

export type ReadAgentLine =
  ({ kind: "agent" } & AgentLine) | { kind: "text"; text: string };

// The title sits unescaped inside its quotes, so it may hold a `"`: the
// conversation id after the LAST `" · ` closes it.
const LINE = /^- (\S+) "(.*)" · ((?:conv|claude)-\S+) · (.*)$/;

export function readAgentList(text: string): ReadAgentLine[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line): ReadAgentLine => {
      const m = LINE.exec(line);
      if (!m) return { kind: "text", text: line.trim() };
      const rest = m[4]!;
      const self = rest.endsWith(SELF_SUFFIX);
      return {
        kind: "agent",
        taskId: m[1]!,
        title: m[2]!,
        conversationId: m[3]!,
        standing: self ? rest.slice(0, -SELF_SUFFIX.length) : rest,
        self,
      };
    });
}
