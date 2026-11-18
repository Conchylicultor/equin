import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { HostServerError } from "../core";

/**
 * A server error a browser host caught in its worker (a live loader's failure
 * — the read got a 500 `loader-failed` — or a route handler's throw), handed
 * to the page with its stack (`PortServerOptions.onServerError`). The host
 * runs no reports engine, so without this the error never leaves the
 * visitor's browser.
 *
 * `browser-server` owns no report: the registered consumer (`reports/crash`)
 * files it through the page's report channel — on a deployed site, the site's
 * visitor reports. Held while nobody is registered (the report-sink contract).
 */
export interface HostServerErrorInfo {
  /** The host's name — a demo's scenario id. */
  host: string;
  error: HostServerError;
}

export const hostServerErrorSink = defineReportSink<HostServerErrorInfo>();
