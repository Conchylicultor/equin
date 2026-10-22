import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * One UTC day of task history: how many tasks were created that day, and how
 * many were resolved — completed (status `done`, at its first completed push)
 * or dropped (status `dropped` at `droppedAt`, or `held` at `heldAt`; held is
 * grouped with dropped so active + completed + dropped = total). `date` is
 * `YYYY-MM-DD`.
 */
export const TaskHistoryDaySchema = z.object({
  date: z.string(),
  added: z.number(),
  completed: z.number(),
  dropped: z.number(),
});
export type TaskHistoryDay = z.infer<typeof TaskHistoryDaySchema>;

/**
 * The task history behind both Stats → Tasks charts: one row per UTC day on
 * which a task was created or resolved, ascending by date. The cumulative
 * (active over time) and daily-velocity series are both derived from it on
 * the client (`cumulativeSeries`, `velocitySeries`).
 *
 * Bound: at most one row per day since the first task — a few hundred rows
 * for a year of use, four small numbers each — so the whole series is small
 * however many tasks there are (aggregated per day in SQL, never one row per
 * task).
 *
 * Day granularity is deliberate, and a shape change for the cumulative chart:
 * the endpoint this replaced plotted one point per event MINUTE, so a day's
 * intraday rises and falls showed; now the chart steps once per day, through
 * the same end-of-day totals. A finer chart is the metrics primitive's job
 * (it replaces this interim value), not a second per-minute series here.
 */
export const tasksHistory = liveValue("stats.tasks.history", {
  schema: z.array(TaskHistoryDaySchema),
});
