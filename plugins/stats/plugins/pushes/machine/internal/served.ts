import { serveValue } from "@plugins/network/plugins/live/machine";
import { _opLogOps } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/server";
import {
  pushesStepBreakdown,
  pushesThroughput,
  pushesWaitTime,
} from "../../shared/values";
import { loadStepBreakdown } from "./step-breakdown";
import { loadThroughput } from "./throughput";
import { loadWaitTime } from "./wait-time";

// Every chart is one SQL aggregate over op-store's `op_log_ops` (change-feed
// covered: op-store's own collections are routed by it). Any ingested op line
// may close a push and move any bucket, so each value reads the whole table.
// The ingester commits every batch of op lines (builds and tests too, not only
// pushes), so a flush is throttled: a chart a few seconds behind a push is
// still the same chart.

export const pushesWaitTimeServed = serveValue(pushesWaitTime, {
  source: "db",
  reads: {
    tables: [_opLogOps],
    reason:
      "an aggregate over every completed push in op_log_ops: any ingested op line may close a push and move any bucket",
  },
  throttleMs: 5_000,
  loader: loadWaitTime,
});

export const pushesThroughputServed = serveValue(pushesThroughput, {
  source: "db",
  reads: {
    tables: [_opLogOps],
    reason:
      "an aggregate over every completed push in op_log_ops: any ingested op line may close a push and move any bucket",
  },
  throttleMs: 5_000,
  loader: loadThroughput,
});

export const pushesStepBreakdownServed = serveValue(pushesStepBreakdown, {
  source: "db",
  reads: {
    tables: [_opLogOps],
    reason:
      "an aggregate over every completed push in op_log_ops: any ingested op line may close a push and move any bucket",
  },
  throttleMs: 5_000,
  loader: loadStepBreakdown,
});
