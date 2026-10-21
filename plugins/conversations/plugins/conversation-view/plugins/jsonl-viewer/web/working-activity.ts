import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { WorkingMood } from "@plugins/primitives/plugins/css/plugins/working-dots/web";

/** What a working agent is doing right now: the dots' mood and the words beside them. */
export interface WorkingActivity {
  mood: WorkingMood;
  label: string;
}

const basename = (path: string) =>
  path.split("/").filter(Boolean).pop() ?? path;

function stringField(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** A running tool call, in words. An MCP tool (`mcp__server__name`) reads as its own name. */
function toolLabel(name: string, input: unknown): string {
  const file =
    stringField(input, "file_path") ?? stringField(input, "notebook_path");
  switch (name) {
    case "Read":
      return file ? `Reading ${basename(file)}` : "Reading a file";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file ? `Editing ${basename(file)}` : "Editing a file";
    case "Write":
      return file ? `Writing ${basename(file)}` : "Writing a file";
    case "Grep":
    case "Glob":
      return "Searching the code";
    case "Bash":
      return "Running a command";
    case "WebSearch":
    case "WebFetch":
      return "Searching the web";
    case "Agent":
    case "Task":
      return "Running a sub-agent";
    default:
      return `Running ${name.split("__").pop() ?? name}`;
  }
}

/**
 * Reads the transcript's tail — with the blocks still being written appended
 * as their stand-ins: writing while reply text streams in (`writing`), the
 * tool by name while the newest call has no result (being written, or
 * running), else thinking (a thinking block, or the model deciding what to do
 * with what it just got back, or with a message handed to it). Bookkeeping
 * events (attachments, api requests, checkpoints…) are skipped. Every kind is
 * listed, so a new one has to pick a side.
 */
export function workingActivityOf(
  events: readonly JsonlEvent[],
  writing: boolean,
): WorkingActivity {
  if (writing) return { mood: "writing", label: "Writing" };
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    switch (e.kind) {
      case "tool-call":
        return e.result
          ? { mood: "thinking", label: "Thinking" }
          : { mood: "tool", label: toolLabel(e.name, e.input) };
      // The agent's own words, or something handed to it: it is deciding what to do next.
      case "assistant-thinking":
      case "assistant-text":
      case "user-text":
      case "user-image":
      case "meta-prompt":
      case "preprompt":
      case "teammate-message":
      case "task-notification":
        return { mood: "thinking", label: "Thinking" };
      // Bookkeeping: says nothing about what the agent is doing.
      case "api-error":
      case "api-request":
      case "attachment":
      case "compaction":
      case "file-checkpoint":
      case "queue-operation":
      case "request-shape":
      case "summary":
      case "system":
      case "unknown":
        continue;
    }
  }
  return { mood: "working", label: "Working" };
}
