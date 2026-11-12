import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { HostBoot } from "../core";

/**
 * One browser host's boot, as the page that waited on it saw it: from the
 * page asking for the host to the host's `ready` — once per boot (a Reset, a
 * reconnect to the next host generation, each boot again). Nothing that
 * reads the host mounts before `ready`, so this wait is the host's own and is
 * never inside any read's mount → first data; a consumer files it once, as
 * the boot it is, instead of on each read (the page's transport bring-up is
 * filed the same way).
 *
 * A measurement only — `browser-server` owns no threshold: the registered
 * consumer (`debug/slow-ops`) judges it against its own budget. An emit with
 * nobody registered is dropped (the report-sink contract).
 */
export interface HostBootInfo {
  /** The host's name — a demo's scenario id. */
  host: string;
  /** Page asked for the host → its `ready`, in ms. */
  waitedMs: number;
  /** When the page asked, on its `performance.now()` clock. */
  askedAtMs: number;
  /** The worker's own account of the boot (stages, data source, when it was created). */
  boot: HostBoot;
  /** When the worker reported ready: ms after it was created, on its clock. */
  readyAtMs: number;
}

export const hostBootReportSink = defineReportSink<HostBootInfo>();
