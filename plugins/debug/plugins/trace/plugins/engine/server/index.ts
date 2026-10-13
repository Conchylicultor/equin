import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import {
  ExcludeFromBackup,
  ExcludeFromFork,
} from "@plugins/database/plugins/admin/server";
import { traceConfig } from "../core";
import { testTrigger } from "../shared/endpoints";
import { handleTestTrigger } from "./internal/handle-test-trigger";
import { traceRetention } from "./internal/retention";
import { _traces } from "./internal/tables";
import { tracesProducer } from "./internal/producer";
import { traceByIdServed, traceEventsServed } from "./internal/resources";

// The generic perf-event trace registry + captureTrace entry point.
export { defineTraceEventClass, TraceEventClass } from "./internal/registry";
export type {
  TraceEventClassSpec,
  TraceEventClassHandle,
} from "./internal/registry";
export { captureTrace } from "./internal/capture";
export { _traces } from "./internal/tables";

export default {
  description:
    "The generic slow-event trace engine: the TraceEventClass registry, captureTrace() admission + coherent-instant capture + async enrich/persist into the durable traces table (fed to live readers by an in-process change producer), the debug.traces list window and debug.trace by-id lookup, a daily 7-day sweep, and the test-trigger verification endpoint.",
  contributions: [
    ConfigV2.Register({ descriptor: traceConfig }),
    // A trace is inserted EXACTLY when a span tripped its slow threshold — i.e.
    // when the system is already under load — so `traces` carries no
    // change-feed trigger: its in-process change producer routes each insert
    // (and the sweep's deletes), coalesced to one flush per 2 s (./internal/producer).
    tracesProducer.declare,
    // The Slow Events list (metadata window) and the detail pane's by-id lookup.
    ...traceEventsServed.declare,
    ...traceByIdServed.declare,
    // A trace is 7-day debugging evidence about the machine that produced it,
    // reachable only from a report/timeline row filed in the SAME database. A
    // forked worktree inherits neither those pointers nor any reason to read
    // main's traces — and this is by far the largest table in the fork (722 MB
    // of a ~970 MB copy), so inheriting it is what made forking take minutes.
    ExcludeFromFork({
      table: _traces,
      reason:
        "Host-local 7-day debugging evidence; nothing in a fresh worktree points at main's traces, and it is the bulk of the fork's bytes.",
    }),
    // And out of the nightly backup: the rows expire within a week, so a
    // restore would find them gone anyway. An empty `traces` after a restore is
    // just an empty Slow Events list.
    ExcludeFromBackup({
      table: _traces,
      reason:
        "7-day debugging evidence, swept nightly; a restore a week later would find it expired anyway.",
    }),
  ],
  httpRoutes: {
    [testTrigger.route]: handleTestTrigger,
  },
  register: [traceRetention],
} satisfies ServerPluginDefinition;
