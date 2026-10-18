import { Log } from "@plugins/primitives/plugins/log-channels/server";

// Single owner of the "jobs" log channel. `Log.channel` throws on a duplicate
// id, so the channel is created exactly once here and shared by every jobs
// server module that writes to it (the worker's boot re-point, the stuck-lock
// sweeper's superseded-row drops).
export const jobsLog = Log.channel("jobs");
