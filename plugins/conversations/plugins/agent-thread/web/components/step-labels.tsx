import type { ReactNode } from "react";
import { toolName } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolNameLabel } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import type { StepLabelProps } from "../slots";

// The words of a step: one line per tool call, read off its input. Labels are
// inline content — the step row is a line container, so the whole label
// truncates as one.

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch (err) {
    if (err instanceof TypeError) return url;
    throw err;
  }
}

/** The first line of the first string an input carries — what a call is about. */
function inputSummary(input: unknown): string | undefined {
  const described = field(input, "description");
  if (described) return described;
  if (typeof input !== "object" || input === null) return undefined;
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim() !== "")
      return value.split("\n")[0];
  }
  return undefined;
}

function Quiet({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** Any tool nobody labels: its name, then what its input is about. */
export function GenericStepLabel({ event }: StepLabelProps) {
  const summary = inputSummary(event.input);
  return (
    <>
      <ToolNameLabel tool={toolName(event.name)} />
      {summary && <Quiet> {summary}</Quiet>}
    </>
  );
}

/** A verb, then its object dimmed — the shape of every generic label. */
function verbed(verb: string, object: string | undefined): ReactNode {
  return object ? (
    <>
      {verb} <Quiet>{object}</Quiet>
    </>
  ) : (
    verb
  );
}

function quoted(text: string | undefined): string | undefined {
  return text && `“${text}”`;
}

function pathLabel(verb: string) {
  return function PathStepLabel({ event }: StepLabelProps) {
    const path = field(event.input, "file_path");
    return verbed(verb, path && basename(path));
  };
}

export const ReadStepLabel = pathLabel("Read");
export const WriteStepLabel = pathLabel("Wrote");
export const EditStepLabel = pathLabel("Edited");

export function BashStepLabel({ event }: StepLabelProps) {
  return verbed(
    "Ran",
    field(event.input, "description") ?? field(event.input, "command"),
  );
}

export function WebSearchStepLabel({ event }: StepLabelProps) {
  return verbed("Searched the web for", quoted(field(event.input, "query")));
}

export function WebFetchStepLabel({ event }: StepLabelProps) {
  const url = field(event.input, "url");
  return verbed("Read", url && hostOf(url));
}

export function GrepStepLabel({ event }: StepLabelProps) {
  return verbed("Searched for", quoted(field(event.input, "pattern")));
}

export function GlobStepLabel({ event }: StepLabelProps) {
  return verbed("Listed files matching", field(event.input, "pattern"));
}

export function ToolSearchStepLabel() {
  return "Loaded its tools";
}

export function TodoWriteStepLabel() {
  return "Updated its plan";
}

export function AskUserQuestionStepLabel() {
  return "Asked you a question";
}

export function AgentStepLabel({ event }: StepLabelProps) {
  return verbed("Started a helper", field(event.input, "description"));
}
