import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { boundaryReportSink } from "@plugins/primitives/plugins/error-boundary/web";
import type { HealthStatus, SetRows } from "../../core";
import { HealthReport } from "../slots";
import {
  HealthStore,
  withStatus,
  withStatusesUnder,
  withoutSet,
  withoutStatus,
} from "../internal/store";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/** Why a check whose hook threw is unknown. */
const CRASHED_SUMMARY = "This check crashed";

/** What a check whose hook threw reports: grey, never green. */
const CRASHED: HealthStatus = { state: "unknown", summary: CRASHED_SUMMARY };

/**
 * Publish one row's status into the report's store, and drop it on unmount.
 *
 * The write runs on every change of `status` (a hook that builds a fresh object
 * each render re-runs it, and `withStatus` bails on a value-equal status, so
 * nobody is notified). The removal is a SEPARATE effect keyed only on the row,
 * so a status change never tears the entry down mid-flight.
 */
function usePublishStatus(id: string, status: HealthStatus): void {
  const store = HealthStore.useStoreApi();
  useEffect(() => {
    store.setState((state) => withStatus(state, id, status));
  }, [store, id, status]);
  useEffect(() => {
    return () => {
      store.setState((state) => withoutStatus(state, id));
    };
  }, [store, id]);
}

/**
 * One status row's always-on reader. Its own component so the contribution's
 * hook is called unconditionally, once per row, whatever else the report does
 * (the detail-sections split: one component per contribution keeps every hook
 * call rules-of-hooks clean). Renders nothing.
 */
function StatusProbe({
  id,
  useStatus,
}: {
  id: string;
  useStatus: Hook<() => HealthStatus>;
}): ReactNode {
  const status = useStatus();
  usePublishStatus(id, status);
  return null;
}

/** Stands in for a probe whose hook threw: keeps the row grey for as long as it is mounted. */
function CrashedProbe({ id }: { id: string }): ReactNode {
  usePublishStatus(id, CRASHED);
  return null;
}

/**
 * Publish one row set's rows into the store — everything under its id replaced
 * in one write (`withStatusesUnder`), so a vanished item goes with it — and
 * drop all of it on unmount. Same split as `usePublishStatus`.
 */
function usePublishSet(id: string, rows: SetRows): void {
  const store = HealthStore.useStoreApi();
  useEffect(() => {
    store.setState((state) => withStatusesUnder(state, id, rows));
  }, [store, id, rows]);
  useEffect(() => {
    return () => {
      store.setState((state) => withoutSet(state, id));
    };
  }, [store, id]);
}

/** One row set's always-on reader: calls `useRows` once for the whole set. */
function SetProbe({
  id,
  useRows,
}: {
  id: string;
  useRows: Hook<() => SetRows>;
}): ReactNode {
  const rows = useRows();
  usePublishSet(id, rows);
  return null;
}

const CRASHED_SET: SetRows = { kind: "error", summary: CRASHED_SUMMARY };

/** A set whose hook threw: one grey row under the set's id, its items dropped. */
function CrashedSetProbe({ id }: { id: string }): ReactNode {
  usePublishSet(id, CRASHED_SET);
  return null;
}

interface ProbeBoundaryProps {
  /** What stands in for the probe once it has crashed. */
  crashed: ReactNode;
  /** The slot's id, for the crash report. */
  slot: string;
  /** The contributing plugin, for the crash report. */
  label: string;
  children: ReactNode;
}

/**
 * Contains a crashing check to its own row. The generic `PluginErrorBoundary`
 * would paint its red crash chip where the probe sits — inside the action
 * bar's button — so this boundary renders a `CrashedProbe` instead (the row
 * turns grey, "This check crashed") and files the crash through the same
 * `boundaryReportSink` every other boundary reports to.
 */
class ProbeBoundary extends Component<
  ProbeBoundaryProps,
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const report = {
      error,
      componentStack: info.componentStack ?? null,
      slot: this.props.slot,
      label: this.props.label,
    };
    // Deferred one macrotask, as `CrashFallback` does: a probe that throws during
    // the very first commit would otherwise emit before the crash reporter's own
    // mount effect has registered the sink, and the report would be lost.
    setTimeout(() => {
      void boundaryReportSink.emit(report);
    }, 0);
  }

  render(): ReactNode {
    return this.state.crashed ? this.props.crashed : this.props.children;
  }
}

/**
 * Mounts one probe per registered status row and row set. A row added later (a
 * deferred plugin tier loading) simply adds a probe; a row whose plugin goes
 * away takes its entries with it.
 */
export function StatusProbes(): ReactNode {
  const rows = HealthReport.Row.useContributions();
  const slot = HealthReport.Row.id;
  return (
    <>
      {rows.map((row) => {
        const label = row._pluginId ?? row.id;
        switch (row.kind) {
          case "status":
            return (
              <ProbeBoundary
                key={row.id}
                crashed={<CrashedProbe id={row.id} />}
                slot={slot}
                label={label}
              >
                <StatusProbe id={row.id} useStatus={row.useStatus} />
              </ProbeBoundary>
            );
          case "set":
            return (
              <ProbeBoundary
                key={row.id}
                crashed={<CrashedSetProbe id={row.id} />}
                slot={slot}
                label={label}
              >
                <SetProbe id={row.id} useRows={row.useRows} />
              </ProbeBoundary>
            );
          case "info":
            return null;
        }
      })}
    </>
  );
}
