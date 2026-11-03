import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { ResourceError } from "../core";

/**
 * One live read that started failing: emitted by `NotificationsClient` when a
 * `(key, params)` tuple's error goes from none to set — ONCE per tuple per
 * failure episode, however many hooks observe it (the client watches the query
 * cache, not the hooks). A caller that ignores its `error` arm therefore still
 * produces a loud signal.
 *
 * Policy-free, like the sibling sinks: live-state only emits; the
 * `reports/resource-errors` collector decides what becomes a report (a
 * `client-outdated` failure is the Reload advice's job, not a bug report).
 * `live-state` must never import `reports`.
 */
export interface ResourceErrorInfo {
  key: string;
  params: Record<string, string>;
  error: ResourceError;
}

export const resourceErrorReportSink = defineReportSink<ResourceErrorInfo>();

/** A tuple currently failing, as the health report's row counts them. */
export interface FailingResource {
  key: string;
  params: Record<string, string>;
  error: ResourceError;
}
