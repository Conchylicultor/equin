import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { JobListStatus, JobProblem } from "./job-rows";

/** How one Jobs status presents: its label, dot colour, badge tint and text colour. */
export interface StatusMeta {
  label: string;
  dot: string;
  badge: BadgeVariant;
  text: string;
}

/**
 * The single presentation of a job row's status, shared by the Queue and
 * History status columns, their filter options and the detail header — so a
 * dot and a badge for the same row cannot disagree.
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

export const PROBLEM_LABEL: Record<JobProblem, string> = {
  "no-worker": "no worker",
  forfeited: "forfeited",
};
