import { mkdirSync, renameSync } from "node:fs";
import { basename } from "node:path";
import {
  appPathParent,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
// Own plugin, so relative.
import { GATEWAY_LOG_BOUND } from "../index";

export type LegacyLogAdoption =
  { kind: "none" } | { kind: "moved"; to: AppPath } | { kind: "slots-full" };

/**
 * One-shot move of a daemon's pre-relay log file (Postgres's `pg_ctl -l` file,
 * PgBouncer's `logfile`) into its service channel's rotation, as the newest
 * free backup (`<live>.1`, else `.2`, …). It then ages out with the rotation
 * instead of being deleted outright — it may still be evidence (the
 * 2026-11-04 connection stall) — and stops being a file nothing bounds.
 *
 * Called on a FRESH daemon start only: a reattached daemon may still be writing
 * the legacy file, and moving it would only rename its open file. With every
 * backup slot taken the file is left where it is (`paths:logs-claimed` keeps
 * naming it). Says which, for the start script's own output.
 *
 * Delete with the legacy path constants once no machine has the files
 * (task-1793827129-t489g4).
 */
export function adoptLegacyLog(
  legacy: AppPath,
  live: AppPath,
): LegacyLogAdoption {
  if (!existsSync(legacy)) return { kind: "none" };
  const dir = appPathParent(live);
  for (let n = 1; n <= GATEWAY_LOG_BOUND.keep; n++) {
    const slot = joinAppPath(dir, `${basename(live)}.${n}`);
    if (existsSync(slot)) continue;
    mkdirSync(dir, { recursive: true });
    renameSync(legacy, slot);
    return { kind: "moved", to: slot };
  }
  return { kind: "slots-full" };
}
