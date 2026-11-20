import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ComponentType } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/** A known verdict about one health check. */
export type HealthState = "ok" | "attention" | "critical";

/**
 * What a status row's `useStatus` hook returns on every render.
 *
 * `unknown` is a state to RENDER (a grey dot), never a stand-in for `ok` — the
 * report must not claim green for something it cannot read. Two flavours:
 *
 * - no `summary` — not known yet (still loading). The dot pulses and the
 *   report says "Checking…", exactly like a row whose probe has not reported.
 * - with a `summary` — known to be unreadable right now ("Unknown while
 *   disconnected", "This check crashed"). The dot is grey and still.
 *
 * `not-applicable` says the check does not apply on this host at all (a
 * machine-only check under a host without the computer): nothing to vouch for,
 * and nothing wrong. It is left out of the merge — it neither greys nor greens
 * the dot — and its row is drawn hollow, last, with `summary` saying why.
 *
 * `absent` says the row has nothing to say on this checkout at all, so it is
 * not drawn (an update row on the repo that has nothing to update from): left
 * out of the merge AND the report. Unlike `not-applicable`, which lists the
 * row hollow with why, it is for a row whose mere presence would be noise.
 *
 * `transitioning` marks a state that is on its way somewhere else (a socket
 * reconnecting): the dot pulses while it is set.
 *
 * `title` (known states only) is what the row is called in this state, for a
 * row whose state IS its name ("equin is out of date" / "equin is up to
 * date"); unset, the row's own `title`. It is also the report's verdict when
 * this row is the one that needs a look.
 */
export type HealthStatus =
  | { state: "unknown"; summary?: string }
  | { state: "not-applicable"; summary: string }
  // `summary?: never` keeps `status.summary` readable on the whole union.
  | { state: "absent"; summary?: never }
  | {
      state: "ok" | "critical";
      summary: string;
      title?: string;
      transitioning?: boolean;
    }
  | {
      state: "attention";
      summary: string;
      title?: string;
      transitioning?: boolean;
      /**
       * Ambient attention: a condition worth seeing in the report but too
       * routine to colour the dot (the machine busy, with the watcher already
       * handling it). The row draws `attention` as usual; the dot treats it as
       * `ok` and shows these marks beside it instead (`mergeDot`). An empty
       * list keeps the dot green and unmarked.
       */
      ambient?: readonly HealthMark[];
    };

/** A small icon the dot shows for an ambient condition (`HealthStatus.ambient`). */
export interface HealthMark {
  /** Stable within its row: keys the mark. */
  id: string;
  icon: IconRef;
  /** What it says, as the icon's accessible name and tooltip. */
  label: string;
}

/** The merged verdict: the worst known state, or `unknown` when a row cannot vouch for itself. */
export type HealthLevel = HealthState | "unknown";

/** What one row shows: a level, or `not-applicable` / `absent` — which the merge never sees. */
export type RowLevel = HealthLevel | "not-applicable" | "absent";

/** What an info row shows: a title and a one-line summary, never a state. */
export interface HealthInfo {
  title: string;
  summary: string;
}

interface RowCommon {
  /**
   * Stable id, unique across every row. Keys the report's per-row status, and
   * names the row in the slot's reorder layout (its place in the report).
   */
  id: string;
  /**
   * Trailing controls on the row (copy, "Open task", "Open queue"), always
   * visible. Rendered inside an error boundary, at the row's compact density.
   * This is where a row links to the pane that explains it — the report itself
   * never names a contributor's pane.
   */
  actions?: ComponentType;
}

/** What a status row's `glance` is rendered with. */
export interface GlanceProps {
  expanded: boolean;
}

/**
 * A row with a health state. Its state feeds the merged dot.
 *
 * `useStatus` is called on EVERY render of the report's host, open or not —
 * that is what colours the dot while the report is closed. Keep it cheap: read a
 * store or a live resource that is already resident; never start a fetch here.
 */
export interface StatusRow extends RowCommon {
  kind: "status";
  /** The row's name ("Connection", "Job queue"). */
  title: string;
  useStatus: Hook<() => HealthStatus>;
  /**
   * Presentational content under the summary, shown while the report is open
   * (per-class fill bars). It sits inside the row's click target when the row
   * is expandable, so it must hold no controls of its own — put those in
   * `actions`. `expanded` says whether the row's detail is open (always
   * `false` on a row without one), so a glance can show less while collapsed
   * and leave the rest to sit beside its detail.
   */
  glance?: ComponentType<GlanceProps>;
  /**
   * The expandable detail, mounted only while the row is expanded. Its presence
   * is what gives the row a chevron: a row without one cannot be expanded.
   */
  component?: ComponentType;
  /**
   * The control that fixes the row's problem ("Update"), drawn after `actions`
   * only while the row is in `attention` or `critical`. Unlike `actions` it
   * does not keep a row out of the quiet card: while the row is `ok` it is not
   * drawn at all, so a row whose only control is a remedy still folds.
   */
  remedy?: ComponentType;
}

/**
 * A row that says WHERE you are, not how healthy it is (the worktree). It has
 * an icon instead of a dot and structurally cannot move the merged dot: there
 * is no field through which it could declare a state.
 */
export interface InfoRow extends RowCommon {
  kind: "info";
  icon: IconRef;
  /** Called only while the report is open. */
  useInfo: Hook<() => HealthInfo>;
  glance?: never;
  component?: never;
  remedy?: never;
}

/** One item of a row set: a status row of its own, named by its `key`. */
export interface SetItem {
  /**
   * Stable within the set: names the item to the set's `glance` / `component` /
   * `actions` / `remedy` (as `rowKey`) and keys its status (`${setId}/${key}`).
   */
  key: string;
  /** The item's name ("site.example.com"). A known state's `title` overrides it, as on a status row. */
  title: string;
  status: HealthStatus;
}

/**
 * What a row set's `useRows` returns on every render: its items, or why there
 * are none to show yet. Not known yet is a state (`pending`), never an empty
 * list.
 */
export type SetRows =
  | { kind: "pending" }
  | { kind: "error"; summary: string }
  | { kind: "ready"; rows: readonly SetItem[] };

/** What a row set's per-item parts are rendered with: which item. */
export interface SetItemProps {
  rowKey: string;
}

/**
 * A SET of status rows from one contribution: one row per item of a live list
 * (one per deployed site). Each item is drawn and merged as an ordinary status
 * row, where the set sits in the slot order; the parts below are the set's,
 * told which item they are drawn for (`rowKey`) — one component instance per
 * item, so a per-item hook inside them is legal.
 *
 * `useRows` is called on EVERY render of the report's host, like a status
 * row's `useStatus`, and once per set: read ONE value that already holds every
 * item's state. Per-item reads belong in `glance` / `component`, mounted only
 * while the report is open.
 *
 * While `pending` the set is one grey "Checking…" row under `title`; on `error`
 * one grey row with the summary; `ready` with no items draws nothing.
 */
export interface SetRow extends Omit<RowCommon, "actions"> {
  kind: "set";
  /** The set's name, drawn on its one row while pending or failed ("Sites"). */
  title: string;
  useRows: Hook<() => SetRows>;
  /** As a status row's `glance`, per item. */
  glance?: ComponentType<GlanceProps & SetItemProps>;
  /** As a status row's `component`, per item: its presence gives every item a chevron. */
  component?: ComponentType<SetItemProps>;
  /** As a row's `actions`, per item. */
  actions?: ComponentType<SetItemProps>;
  /** As a status row's `remedy`, per item: drawn while that item needs a look. */
  remedy?: ComponentType<SetItemProps>;
}

/** One contribution to `HealthReport.Row`. */
export type HealthReportRow = StatusRow | InfoRow | SetRow;

/** The fold of every status row's status — what the dot shows. */
export interface HealthMerge {
  /** Worst state: `critical > attention > unknown > ok`. `ok` for zero rows. */
  state: HealthLevel;
  /** Rows in `attention` or `critical`. */
  count: number;
  /** Some row is `transitioning`. */
  transitioning: boolean;
  /** Some row is not known yet (unreported, or `unknown` without a summary). */
  pending: boolean;
}

/** What the dot shows: the merge with ambient rows folded as `ok`, and their marks. */
export interface DotMerge extends HealthMerge {
  /** Every ambient row's marks, in row order. */
  marks: HealthMark[];
}
