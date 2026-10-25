import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/** One `events_test.log` job run, as the job recorded it. */
export const LogEntrySchema = z.object({
  label: z.string(),
  userId: z.string(),
  message: z.string(),
  jobId: z.string(),
  firedAt: z.string(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

/** How many of the latest log entries {@link eventsTestLog} carries. */
export const EVENTS_TEST_LOG_WINDOW = 200;

/**
 * The job log the Events Test pane shows: the newest
 * {@link EVENTS_TEST_LOG_WINDOW} entries in the order they fired, plus how many
 * the log holds in all. Bounded by the window: the in-memory log grows by one
 * entry per job run until it is reset or the process restarts, so the payload
 * is never the whole log. External (the log lives in the server process),
 * `notified` by the job on every append and by the reset.
 */
export const eventsTestLog = liveValue("events-test.log", {
  schema: z.object({
    entries: cappedList(LogEntrySchema, { max: EVENTS_TEST_LOG_WINDOW }),
    total: z.number(),
  }),
});
