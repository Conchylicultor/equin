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
 * `transitioning` marks a state that is on its way somewhere else (a socket
 * reconnecting): the dot pulses while it is set.
 */
export type HealthStatus =
  | { state: "unknown"; summary?: string }
  | { state: "not-applicable"; summary: string }
  | { state: HealthState; summary: string; transitioning?: boolean };

/** The merged verdict: the worst known state, or `unknown` when a row cannot vouch for itself. */
export type HealthLevel = HealthState | "unknown";

/** What one row shows: a level, or `not-applicable` — which the merge never sees. */
export type RowLevel = HealthLevel | "not-applicable";

/** What an info row shows: a title and a one-line summary, never a state. */
export interface HealthInfo {
  title: string;
  summary: string;
}

interface RowCommon {
  /** Stable id, unique across every row. Keys the report's per-row status. */
  id: string;
  /** Tie-break among rows of equal severity (and the order of info rows). Lower first. */
  order: number;
  /**
   * Trailing controls on the row (copy, "Open task", "Open queue"), always
   * visible. Rendered inside an error boundary, at the row's compact density.
   * This is where a row links to the pane that explains it — the report itself
   * never names a contributor's pane.
   */
  actions?: ComponentType;
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
   * `actions`.
   */
  glance?: ComponentType;
  /**
   * The expandable detail, mounted only while the row is expanded. Its presence
   * is what gives the row a chevron: a row without one cannot be expanded.
   */
  component?: ComponentType;
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
}

/** One contribution to `HealthReport.Row`. */
export type HealthReportRow = StatusRow | InfoRow;

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
