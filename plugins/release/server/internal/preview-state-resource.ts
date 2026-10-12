import { serveValue } from "@plugins/network/plugins/live/server";
import type { DaemonInstance } from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { releasePreviews, type Preview } from "../../core/resources";

// The in-memory preview registry, keyed by runId. The server projects this into
// the `release.previews` value (a `Record<runId, Preview>`); the preview
// manager mutates it and calls `releasePreviewsServed.notify()`.
export interface PreviewEntry {
  runId: string;
  /** The preview's stack, as the daemon primitive follows it (by its gateway's
   * pid file) — never projected onto the wire. */
  daemon: DaemonInstance;
  port: number;
  // The per-instance Postgres TCP port handed to this preview's embedded cluster
  // (SINGULARITY_PG_PORT). Kept so teardown can backstop-kill the PG listener.
  pgPort: number;
  url: string;
  dataRoot: string;
  status: "running" | "stopped";
}

export const previews = new Map<string, PreviewEntry>();

function snapshot(): Record<string, Preview> {
  const out: Record<string, Preview> = {};
  for (const [runId, p] of previews) {
    out[runId] = { runId, status: p.status, port: p.port, url: p.url };
  }
  return out;
}

// External: the truth is the in-memory Map above, not Postgres, so the only
// way to push a change is the served value's own `notify()`.
export const releasePreviewsServed = serveValue(releasePreviews, {
  source: "external",
  changes: "notified",
  loader: () => snapshot(),
});
