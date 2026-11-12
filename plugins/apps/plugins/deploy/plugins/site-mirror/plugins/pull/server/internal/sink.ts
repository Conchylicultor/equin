import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { MirrorCustomSink } from "@plugins/database/plugins/table-mirror/plugins/replica/server";

/** The deployed site a sink's pages come from: this computer's own deployment row. */
export interface SiteMirrorSite {
  deploymentId: string;
  hostnames: readonly string[];
}

/**
 * How fast a sink set is read — its flood bound. Each pull is ONE fetch step
 * (a change page, a copy page, or one keys page with its differing rows) of at
 * most `rowsPerRun` rows, never followed up, and a pull asked within
 * `minIntervalMs` of the last one does nothing: the hourly pull-all is what
 * reads it.
 */
export interface SiteMirrorPace {
  /** Rows (and keys, for a reconcile page) one pull may hand the sink. */
  rowsPerRun: number;
  /** A page's byte cap on row JSON, asked of the box. */
  maxBytes: number;
  /** One answer's byte cap, re-checked here before it is parsed. */
  maxAnswerBytes: number;
  /** Pulls closer together than this are skipped. */
  minIntervalMs: number;
}

export interface SiteMirrorSinkSpec {
  /** The mirror set read through this sink (its source declares it with `MirrorSet`). */
  setId: string;
  /** The sink for one deployment's pages: run in each page's transaction. */
  sink(site: SiteMirrorSite): MirrorCustomSink;
  pace: SiteMirrorPace;
  /** Why this set is read through a sink rather than copied. */
  reason: string;
}

/**
 * A mirror set this computer reads as a change stream through a sink of the
 * owner's own, never as copied rows (table-mirror's custom sink: only the
 * content-free key index is kept). Such a set is kept for EVERY deployment —
 * the hourly pull-all creates its replica, no tab asks for it — and is read
 * at its `pace` only: the sync endpoint never pulls it.
 */
export const SiteMirrorSink = defineServerContribution<SiteMirrorSinkSpec>(
  "site-mirror-sink",
  { docLabel: (s) => s.setId },
);

/** The sink contributed for a set, if it is read through one. */
export function siteMirrorSinkOf(setId: string): SiteMirrorSinkSpec | null {
  return (
    SiteMirrorSink.getContributions().find((s) => s.setId === setId) ?? null
  );
}
