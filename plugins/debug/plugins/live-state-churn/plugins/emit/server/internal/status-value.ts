import { serveValue } from "@plugins/network/plugins/live/server";
import { liveStateEmitStatus } from "../../shared/resources";
import { getStatus, onEmitStatusChange } from "./emitter";

// Notified by the emitter itself on every status change (start, stop,
// auto-stop, each tick), only while a tab is subscribed. A session ticks up to
// 100/s, so `throttleMs` ships at most one status per second — the cadence the
// pane's old poll read it at; the tick count it shows is a progress readout.
export const emitStatusServed = serveValue(liveStateEmitStatus, {
  source: "external",
  changes: "notified",
  loader: getStatus,
  throttleMs: 1000,
  whileSubscribed: (_params, notify) => onEmitStatusChange(() => notify()),
});
