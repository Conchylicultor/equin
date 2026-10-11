import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { FieldOption } from "@plugins/primitives/plugins/data-view/web";
import type { JobListStatus, JobProblem } from "./job-rows";

/** How one Jobs status presents: its label, dot colour, badge tint and text colour. */
export interface StatusMeta {
  label: string;
  dot: string;
  badge: BadgeVariant;
  text: string;
}

/**
 * The single presentation of a Jobs row's status, shared by the list's status
 * column, its filter options and the detail header — so a dot and a badge for
 * the same row cannot disagree.
 */
export const STATUS_META: Record<JobListStatus, StatusMeta> = {
  pending: {
    label: "Pending",
    dot: "bg-info",
    badge: "info",
    text: "text-info",
  },
  running: {
    label: "Running",
    dot: "bg-warning",
    badge: "warning",
    text: "text-warning",
  },
  retrying: {
    label: "Retrying",
    dot: "bg-warning",
    badge: "warning",
    text: "text-warning",
  },
  dead: {
    label: "Dead",
    dot: "bg-destructive",
    badge: "destructive",
    text: "text-destructive",
  },
  succeeded: {
    label: "Succeeded",
    dot: "bg-success",
    badge: "success",
    text: "text-success",
  },
  failed: {
    label: "Failed",
    dot: "bg-destructive",
    badge: "destructive",
    text: "text-destructive",
  },
  suspended: {
    label: "Suspended",
    dot: "bg-muted-foreground",
    badge: "muted",
    text: "text-muted-foreground",
  },
};

export const STATUS_OPTIONS: FieldOption[] = (
  Object.keys(STATUS_META) as JobListStatus[]
).map((value) => ({
  value,
  label: STATUS_META[value].label,
  variant: STATUS_META[value].badge,
}));

export const PROBLEM_LABEL: Record<JobProblem, string> = {
  "no-worker": "no worker",
  forfeited: "forfeited",
};

export const PROBLEM_OPTIONS: FieldOption[] = (
  Object.keys(PROBLEM_LABEL) as JobProblem[]
).map((value) => ({
  value,
  label: PROBLEM_LABEL[value],
  variant: "destructive",
}));
