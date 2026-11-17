import {
  parseInstallEventLine,
  type InstallEvent,
  type InstallStepId,
} from "@plugins/installer/core";

/**
 * What the installer window shows, folded from the event stream one event at
 * a time — so the page is a pure function of the event list (a reload replays
 * the backlog into a fresh view and lands on the same screen).
 */

export type StepState = "pending" | "active" | "done" | "skipped" | "failed";

export interface ViewStep {
  readonly id: InstallStepId;
  readonly label: string;
  state: StepState;
}

export interface LogRow {
  readonly kind: "section" | "line" | "err";
  readonly text: string;
}

export type Phase =
  /** No plan yet. */
  | "waiting"
  | "running"
  /** A step failed and the script waits for a decision (retry / quit). */
  | "failed"
  /** The script ended without finishing. */
  | "stopped"
  | "done"
  /** A line broke the protocol: the window cannot tell what is happening. */
  | "protocol-error";

export interface InstallView {
  phase: Phase;
  steps: ViewStep[];
  log: LogRow[];
  doneUrl: string | null;
  exitCode: number | null;
  protocolError: string | null;
}

export function emptyView(): InstallView {
  return {
    phase: "waiting",
    steps: [],
    log: [],
    doneUrl: null,
    exitCode: null,
    protocolError: null,
  };
}

/** Colour and cursor codes a tool printed: the log is plain text. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Fold one line of the stream into the view. */
export function applyLine(view: InstallView, line: string): void {
  if (view.phase === "protocol-error") return;
  const parsed = parseInstallEventLine(line);
  if (!parsed.ok) {
    view.phase = "protocol-error";
    view.protocolError = `${parsed.error}\n\n${line.slice(0, 500)}`;
    return;
  }
  applyEvent(view, parsed.event);
}

export function applyEvent(view: InstallView, event: InstallEvent): void {
  switch (event.type) {
    case "plan":
      view.steps = event.steps.map((s) => ({
        id: s.id,
        label: s.label,
        state: "pending",
      }));
      view.phase = "running";
      return;
    case "step": {
      const step = view.steps.find((s) => s.id === event.id);
      if (step === undefined) {
        view.phase = "protocol-error";
        view.protocolError = `step "${event.id}" is not in the plan`;
        return;
      }
      if (event.state === "start") {
        step.state = "active";
        view.phase = "running";
        view.log.push({ kind: "section", text: step.label });
      } else if (event.state === "failed") {
        step.state = "failed";
        view.phase = "failed";
      } else {
        step.state = event.state;
      }
      return;
    }
    case "log":
      view.log.push({
        kind: event.stream === "err" ? "err" : "line",
        text: event.line.replace(ANSI, ""),
      });
      return;
    case "done":
      view.doneUrl = event.url;
      view.phase = "done";
      return;
    case "exit":
      view.exitCode = event.code;
      if (view.phase !== "done") view.phase = "stopped";
      return;
  }
}

/** The step running now (or the one that failed), with its 0-based index. */
export function currentStep(
  view: InstallView,
): { step: ViewStep; index: number } | null {
  const index = view.steps.findIndex(
    (s) => s.state === "active" || s.state === "failed",
  );
  const step = view.steps[index];
  return step === undefined ? null : { step, index };
}

/**
 * How far the install is, 0 to 1, by steps finished. No time estimates yet
 * (none are measured), so the bar moves a step at a time — never by a guess.
 */
export function progress(view: InstallView): number {
  if (view.phase === "done") return 1;
  if (view.steps.length === 0) return 0;
  const finished = view.steps.filter(
    (s) => s.state === "done" || s.state === "skipped",
  ).length;
  return finished / view.steps.length;
}
