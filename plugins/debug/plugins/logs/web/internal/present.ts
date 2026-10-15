import { namespaceFromHost } from "@plugins/infra/plugins/namespace/core";
import type { LogEntry, LogScope } from "../../shared/resources";

/** The worktree this page is served for: whose logs open by default. */
export function servedWorktree(): string | null {
  return namespaceFromHost(window.location.host);
}

export const SCOPE_LABEL: Record<LogScope, string> = {
  worktree: "This worktree",
  backend: "Backend process",
  host: "Host-wide",
  undeclared: "Undeclared · clientLog",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatSpan(ms: number): string {
  const min = 60_000;
  if (ms < min) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 60 * min) return `${Math.round(ms / min)} min`;
  if (ms < 24 * 60 * min) return `${Math.round(ms / (60 * min))} h`;
  return `${Math.round(ms / (24 * 60 * min))} d`;
}

/** The live file, if the log has written since its last rotation. */
export const liveFile = (e: LogEntry) =>
  e.files.find((f) => f.generation === 0) ?? null;

export const rotatedFiles = (e: LogEntry) =>
  e.files.filter((f) => f.generation > 0);

export const bytesOnDisk = (e: LogEntry): number =>
  e.files.reduce((sum, f) => sum + f.bytes, 0);

export const lastWrite = (e: LogEntry): number | null =>
  e.files.length === 0 ? null : Math.max(...e.files.map((f) => f.modifiedMs));

/**
 * How long until the live file reaches its bound, at the rate it has grown
 * since it was started — `null` with no bound or no growth to go by.
 */
export function rotatesIn(e: LogEntry, now: number): number | null {
  const live = liveFile(e);
  if (e.bound === null || live === null || live.bytes === 0) return null;
  const age = live.modifiedMs - live.bornMs;
  if (age <= 0) return null;
  const rate = live.bytes / age;
  return (
    Math.max(0, (e.bound.maxBytes - live.bytes) / rate) +
    (live.modifiedMs - now)
  );
}

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});
const DAY = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const formatLineTime = (t: number): string => TIME.format(t);
export const formatDay = (t: number): string => DAY.format(t);
