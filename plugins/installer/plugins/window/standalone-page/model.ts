import {
  parseInstallEventLine,
  type FixTarget,
  type InstallEvent,
  type InstallGroupId,
  type InstallStepId,
  type NoticeState,
  type PauseKind,
  type PauseManualId,
  type ProgressUnit,
  type WaitHolder,
  type WaitOn,
} from "@plugins/installer/core";

/**
 * What the installer window shows, folded from the event stream one event at
 * a time — so the page is a pure function of the event list plus the clock
 * (a reload replays the backlog into a fresh view and lands on the same
 * screen). Every time-dependent read takes `now` (epoch ms) as an argument.
 */

export type StepState = "pending" | "active" | "done" | "skipped" | "failed";

/** A unit of work with its own timing: a top-level step, or a sub-step of one. */
export interface ViewLeaf {
  readonly id: InstallStepId;
  readonly label: string;
  /** What it does, as it happens ("Downloading equin"). */
  readonly doing: string;
  /** Its median on a clean install, seconds; null when none is measured. */
  readonly est: number | null;
  state: StepState;
  /** When its current attempt started (epoch ms), from the event's `t`. */
  startedAt: number | null;
  /** How long its last attempt took (ms): the event's `ms`, else from `t`. */
  tookMs: number | null;
  endedAt: number | null;
}

export interface ViewStep extends ViewLeaf {
  readonly group: InstallGroupId;
  /** The sub-steps it is made of, in run order (empty for most steps). */
  readonly substeps: ViewLeaf[];
}

export interface ViewGroup {
  readonly id: InstallGroupId;
  readonly label: string;
}

export interface LogRow {
  readonly kind: "section" | "line" | "err";
  readonly text: string;
}

export interface Progress {
  readonly done: number;
  readonly total: number | null;
  readonly unit: ProgressUnit;
  /** When it was reported (epoch ms). */
  readonly at: number;
}

export interface Wait {
  readonly step: InstallStepId;
  readonly on: WaitOn;
  readonly holder: WaitHolder | null;
  readonly since: number;
}

/** A pause the step engine diagnosed (the `pause` event). */
export interface Pause {
  readonly step: InstallStepId | null;
  readonly kind: PauseKind;
  readonly title: string;
  readonly text: string;
  readonly evidence: readonly string[];
  /** The step stopped and the script waits for a decision; else it goes on (a stall). */
  readonly blocking: boolean;
  readonly optional: boolean;
  readonly manual: {
    readonly id: PauseManualId;
    readonly label: string;
  } | null;
}

/** An optional part the install went on without, and where it stands now. */
export interface Notice {
  readonly id: string;
  readonly state: NoticeState;
  readonly title: string;
  readonly text: string;
  readonly without: string;
}

export type Phase =
  /** No plan yet. */
  | "waiting"
  | "running"
  /** A step failed with no diagnosis: the script waits for retry / quit. */
  | "failed"
  /** A diagnosed pause is open (`view.pause`): blocking, or a stall the install waits through. */
  | "paused"
  /** The script ended without finishing. */
  | "stopped"
  | "done"
  /** A line broke the protocol: the window cannot tell what is happening. */
  | "protocol-error";

export interface InstallView {
  phase: Phase;
  groups: ViewGroup[];
  steps: ViewStep[];
  log: LogRow[];
  /** The latest count reported per step id. */
  progress: Map<InstallStepId, Progress>;
  /** The wait open now, if any. */
  wait: Wait | null;
  /** Every finished wait, as [start, end) epoch ms — not work, never timed as such. */
  waited: Array<readonly [number, number]>;
  doneUrl: string | null;
  exitCode: number | null;
  protocolError: string | null;
  /** The pause open now, if any. */
  pause: Pause | null;
  /** Fix with Claude was started for the open pause: where, and whether the prompt is on the clipboard. */
  fixing: { readonly target: FixTarget; readonly clipboard: boolean } | null;
  /** The latest notice of a part left out, if any. */
  notice: Notice | null;
  /** From the plan, for a report: the release installed (null: main / a checkout), and `<os>-<arch>`. */
  release: string | null;
  platform: string;
}

export function emptyView(): InstallView {
  return {
    phase: "waiting",
    groups: [],
    steps: [],
    log: [],
    progress: new Map(),
    wait: null,
    waited: [],
    doneUrl: null,
    exitCode: null,
    protocolError: null,
    pause: null,
    fixing: null,
    notice: null,
    release: null,
    platform: "",
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

function newLeaf(s: {
  id: InstallStepId;
  label: string;
  doing: string;
  est_s: number | null;
}): ViewLeaf {
  return {
    id: s.id,
    label: s.label,
    doing: s.doing,
    est: s.est_s,
    state: "pending",
    startedAt: null,
    tookMs: null,
    endedAt: null,
  };
}

/** The step or sub-step `id` names, with the top-level step it belongs to. */
function findLeaf(
  view: InstallView,
  id: InstallStepId,
): { leaf: ViewLeaf; parent: ViewStep | null } | null {
  for (const step of view.steps) {
    if (step.id === id) return { leaf: step, parent: null };
    const sub = step.substeps.find((s) => s.id === id);
    if (sub !== undefined) return { leaf: sub, parent: step };
  }
  return null;
}

function protocolError(view: InstallView, message: string): void {
  view.phase = "protocol-error";
  view.protocolError = message;
}

export function applyEvent(view: InstallView, event: InstallEvent): void {
  const at = Date.parse(event.t);
  switch (event.type) {
    case "plan":
      view.groups = event.groups.map((g) => ({ id: g.id, label: g.label }));
      view.steps = event.steps.map((s) => ({
        ...newLeaf(s),
        group: s.group,
        substeps: (s.substeps ?? []).map(newLeaf),
      }));
      if (!view.steps.every((s) => view.groups.some((g) => g.id === s.group))) {
        protocolError(
          view,
          "a step of the plan names a group the plan does not list",
        );
        return;
      }
      view.release = event.release;
      view.platform = event.platform;
      view.phase = "running";
      return;
    case "step": {
      const found = findLeaf(view, event.id);
      if (found === null) {
        protocolError(view, `step "${event.id}" is not in the plan`);
        return;
      }
      const { leaf, parent } = found;
      if (event.state === "start") {
        leaf.state = "active";
        leaf.startedAt = at;
        leaf.endedAt = null;
        leaf.tookMs = null;
        view.progress.delete(leaf.id);
        view.phase = "running";
        view.pause = null;
        view.fixing = null;
        // A step run again (Try again) runs its sub-steps again.
        if (parent === null)
          for (const sub of (leaf as ViewStep).substeps) {
            Object.assign(sub, {
              state: "pending",
              startedAt: null,
              tookMs: null,
              endedAt: null,
            } satisfies Partial<ViewLeaf>);
            view.progress.delete(sub.id);
          }
        // A step whose first sub-step starts at once has nothing of its own
        // to show: its section gives way to the sub-step's.
        const last = view.log.at(-1);
        if (
          parent !== null &&
          last?.kind === "section" &&
          last.text === parent.doing
        )
          view.log.pop();
        view.log.push({ kind: "section", text: leaf.doing });
        return;
      }
      leaf.state = event.state;
      if (event.state === "skipped") return;
      leaf.endedAt = at;
      leaf.tookMs =
        event.ms ?? (leaf.startedAt === null ? null : at - leaf.startedAt);
      if (event.state === "failed") view.phase = "failed";
      return;
    }
    case "pause":
      view.pause = {
        step: event.step,
        kind: event.kind,
        title: event.title,
        text: event.text,
        evidence: event.evidence,
        blocking: event.blocking,
        optional: event.optional,
        manual: event.manual,
      };
      view.fixing = null;
      view.phase = "paused";
      return;
    case "resolved":
      view.pause = null;
      view.fixing = null;
      // Retry: its step's start follows; quit: the exit does. A stall's
      // step simply goes on.
      if (view.phase === "paused") view.phase = "running";
      return;
    case "fixing":
      view.fixing = { target: event.target, clipboard: event.clipboard };
      return;
    case "notice":
      view.notice = {
        id: event.id,
        state: event.state,
        title: event.title,
        text: event.text,
        without: event.without,
      };
      return;
    case "progress":
      view.progress.set(event.id, {
        done: event.done,
        total: event.total,
        unit: event.unit,
        at,
      });
      return;
    case "wait":
      if (event.state === "start") {
        view.wait = {
          step: event.step,
          on: event.on,
          holder: event.holder ?? null,
          since: at,
        };
      } else if (view.wait !== null) {
        view.waited.push([view.wait.since, at]);
        view.wait = null;
      }
      return;
    case "log":
      view.log.push({
        kind: event.stream === "err" ? "err" : "line",
        text: event.line.replace(ANSI, ""),
      });
      return;
    case "done":
      view.doneUrl = event.url;
      view.phase = "done";
      view.wait = null;
      return;
    case "exit":
      view.exitCode = event.code;
      view.pause = null;
      view.fixing = null;
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
 * What is running now: the current step's running (or failed) sub-step, else
 * the step itself (between two sub-steps, or a step without any).
 */
export function currentLeaf(view: InstallView): ViewLeaf | null {
  const cur = currentStep(view);
  if (cur === null) return null;
  return (
    cur.step.substeps.find(
      (s) => s.state === "active" || s.state === "failed",
    ) ?? cur.step
  );
}

/**
 * The group the install is in ("Step 2 of 5"), 0-based: the running step's,
 * else the first group with work left, else the last.
 */
export function currentGroup(
  view: InstallView,
): { index: number; count: number } | null {
  if (view.groups.length === 0) return null;
  const step =
    currentStep(view)?.step ??
    view.steps.find((s) => s.state === "pending") ??
    null;
  const index =
    step === null
      ? view.groups.length - 1
      : view.groups.findIndex((g) => g.id === step.group);
  return { index, count: view.groups.length };
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** How much of [from, to) was spent waiting (a wait is not work). */
function waitedWithin(view: InstallView, from: number, to: number): number {
  const spans: Array<readonly [number, number]> =
    view.wait === null ? view.waited : [...view.waited, [view.wait.since, to]];
  let total = 0;
  for (const [a, b] of spans)
    total += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return total;
}

/**
 * The leaves the time math runs over: each step's sub-steps when it has any
 * (their estimates, their timing), else the step itself.
 */
function timedLeaves(view: InstallView): ViewLeaf[] {
  return view.steps.flatMap((s) => (s.substeps.length > 0 ? s.substeps : [s]));
}

/** Seconds a leaf worked: its finished attempt's time, or the running one's so far — waits excluded. */
export function workedSeconds(
  view: InstallView,
  leaf: ViewLeaf,
  now: number,
): number {
  if (leaf.startedAt === null) return 0;
  if (leaf.state === "active") {
    const end = Math.max(now, leaf.startedAt);
    return (
      (end - leaf.startedAt - waitedWithin(view, leaf.startedAt, end)) / 1000
    );
  }
  if (leaf.tookMs === null) return 0;
  const end = leaf.endedAt ?? leaf.startedAt + leaf.tookMs;
  return (
    Math.max(0, leaf.tookMs - waitedWithin(view, end - leaf.tookMs, end)) / 1000
  );
}

/**
 * How fast this machine runs against the medians: Σ actual / Σ estimate over
 * the finished steps that had an estimate; 1 before any has finished.
 */
export function pace(view: InstallView): number {
  let actual = 0;
  let est = 0;
  for (const leaf of timedLeaves(view)) {
    if (leaf.state !== "done" || leaf.est === null) continue;
    actual += workedSeconds(view, leaf, 0);
    est += leaf.est;
  }
  return est > 0 ? actual / est : 1;
}

/**
 * Seconds left, or null when any step still to run has no measured median —
 * then the window shows no time at all, never a guess. Each step's estimate
 * is scaled by `pace`; the running one counts what is left of its scaled
 * estimate (never below 0). Time spent in a wait is not work, so the number
 * holds still while one is open.
 */
export function remainingSeconds(
  view: InstallView,
  now: number,
): number | null {
  const p = pace(view);
  let left = 0;
  for (const leaf of timedLeaves(view)) {
    if (leaf.state === "done" || leaf.state === "skipped") continue;
    if (leaf.est === null) return null;
    // The running step — or the one paused on — counts what is left of it:
    // the bar of a paused install stays where the install stopped.
    left +=
      leaf.state === "active" || leaf.state === "failed"
        ? Math.max(0, leaf.est * p - workedSeconds(view, leaf, now))
        : leaf.est * p;
  }
  return left;
}

/**
 * How far the install is, 0 to 1. With every remaining step estimated, by
 * time: worked so far / (worked so far + remaining). Otherwise by finished
 * steps, a step's finished sub-steps counting as fractions of it — never by a
 * guess.
 */
export function progress(view: InstallView, now: number): number {
  if (view.phase === "done") return 1;
  if (view.steps.length === 0) return 0;
  const left = remainingSeconds(view, now);
  if (left !== null) {
    let worked = 0;
    for (const leaf of timedLeaves(view))
      if (leaf.state !== "skipped") worked += workedSeconds(view, leaf, now);
    return worked + left === 0 ? 0 : worked / (worked + left);
  }
  const finished = (s: ViewLeaf): boolean =>
    s.state === "done" || s.state === "skipped";
  let sum = 0;
  for (const step of view.steps) {
    if (finished(step)) sum += 1;
    else if (step.substeps.length > 0)
      sum += step.substeps.filter(finished).length / step.substeps.length;
  }
  return sum / view.steps.length;
}

// ── Words ────────────────────────────────────────────────────────────────────

/** "Less than a minute remaining" under 50 s, else "About N minute(s) remaining". */
export function remainingText(seconds: number): string {
  if (seconds < 50) return "Less than a minute remaining";
  const m = Math.max(1, Math.round(seconds / 60));
  return `About ${m} minute${m === 1 ? "" : "s"} remaining`;
}

/** How long ago, in words: "less than a minute ago", "12 min ago", "3 hours ago". */
export function agoText(seconds: number): string {
  if (seconds < 60) return "less than a minute ago";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const h = Math.floor(seconds / 3600);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

/** The status line for an open wait (the installer message rules: no internal names). */
function waitText(wait: Wait, now: number): string {
  if (wait.holder !== null) {
    const ago = agoText(
      Math.max(0, now - Date.parse(wait.holder.startedAt)) / 1000,
    );
    return `Waiting for another task to finish · a ${wait.holder.kind} started ${ago}`;
  }
  switch (wait.on) {
    case "host-grant":
      return "Waiting for other work on this Mac to finish…";
    case "lock":
      return "Waiting for another run of this step to finish…";
    case "apple-installer":
      return "Installing Apple's developer tools: click Install in Apple's window…";
    case "password":
      return "Waiting for your password…";
  }
}

/**
 * The running state's status line: what is happening now, with its count
 * when the tool doing it gave one (`Compiling native modules · 137 of 312`),
 * else `<doing>…`; an open wait says what it waits for instead.
 */
export function statusText(view: InstallView, now: number): string {
  if (view.wait !== null) return waitText(view.wait, now);
  const leaf = currentLeaf(view);
  if (leaf === null) return "Getting ready…";
  // The latest count for what runs now: its own, or its step's reported since it started.
  const parent = currentStep(view)?.step;
  const counts = [view.progress.get(leaf.id)];
  if (parent !== undefined && parent !== leaf)
    counts.push(view.progress.get(parent.id));
  const count = counts
    .filter(
      (c): c is Progress => c !== undefined && c.at >= (leaf.startedAt ?? 0),
    )
    .sort((a, b) => b.at - a.at)[0];
  if (count === undefined || count.total === null) return `${leaf.doing}…`;
  if (count.unit === "%") return `${leaf.doing} · ${count.done}%`;
  return `${leaf.doing} · ${countText(count.done, count.total, count.unit)}`;
}

/**
 * What a count counts, in the user's words (no internal names: cargo's
 * crates are the "components" equin compiles). Exhaustive over the units, so
 * a new one does not compile until it has words.
 */
const UNIT_WORDS: Record<Exclude<ProgressUnit, "%">, string> = {
  crates: "components compiled",
  plugins: "plugins built",
  packages: "packages installed",
};

/** `1,088 of 1,385 components compiled`. */
function countText(
  done: number,
  total: number,
  unit: Exclude<ProgressUnit, "%">,
): string {
  const n = (x: number): string => x.toLocaleString("en-US");
  return `${n(done)} of ${n(total)} ${UNIT_WORDS[unit]}`;
}

/**
 * The caption under the bar: `Step N of G` (plan groups), then `Paused`
 * after a failure (`Still waiting` through a stall), else the time remaining when every step left has an
 * estimate. Returned as parts, so the renderer draws the separator.
 */
export function captionParts(view: InstallView, now: number): string[] {
  const group = currentGroup(view);
  if (group === null) return [];
  const parts = [`Step ${group.index + 1} of ${group.count}`];
  // One state, one word: a stall is not a pause (its step keeps running),
  // so it reads as the screen's own title does.
  if (view.phase === "paused" && view.pause?.blocking === false)
    parts.push("Still waiting");
  else if (view.phase === "failed" || view.phase === "paused")
    parts.push("Paused");
  else {
    const left = remainingSeconds(view, now);
    if (left !== null) parts.push(remainingText(left));
  }
  return parts;
}
