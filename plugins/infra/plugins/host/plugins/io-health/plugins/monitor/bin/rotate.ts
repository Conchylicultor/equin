// Keeps the monitor's log bounded: past ROTATE_AT_BYTES, every tick older than
// the trailing KEEP_TAIL_S moves into a gzipped archive, and the live file is
// replaced by the tail alone — so the app's reader (which restarts at the tail
// of a replaced file) still sees the trailing hour its detector needs. Archives
// are kept RETAIN_DAYS, except the calibration history the detector's
// thresholds were chosen from, which is kept for good.
import { gzipSync } from "node:zlib";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** ~1.3 days of ticks (≈1–1.7 KB each, every 30 s). */
export const ROTATE_AT_BYTES = 4 * 1024 * 1024;
/** Two hours stay live: the detector's window is one, the reader's tail ~4. */
export const KEEP_TAIL_S = 2 * 3600;
export const RETAIN_DAYS = 90;
/**
 * The end of the 2026-11-03/04 history every io-health threshold was chosen
 * from (`IO_HEALTH_THRESHOLDS`): an archive starting before it is never pruned.
 */
export const CALIBRATION_END_ISO = "2026-11-04T20:05:00Z";
export const ARCHIVE_DIR = "fs-latency-archive";

/** Where the log splits: every line before `index` is older than the cutoff. */
export function splitAt(lines: string[], cutoffT: number): number {
  for (let i = 0; i < lines.length; i++) {
    const t = (JSON.parse(lines[i]!) as { t: number }).t;
    if (t >= cutoffT) return i;
  }
  return lines.length;
}

/** `fs-latency-<first>--<last>.jsonl.gz`, ISO instants with `:` made `-`. */
export function archiveName(firstIso: string, lastIso: string): string {
  const f = (iso: string) => iso.replaceAll(":", "-");
  return `fs-latency-${f(firstIso)}--${f(lastIso)}.jsonl.gz`;
}

const ARCHIVE = /^fs-latency-(.+)--(.+)\.jsonl\.gz$/;

/** The instants an archive's name spans, or null for a file that is not one. */
export function archiveSpan(
  name: string,
): { firstIso: string; lastIso: string } | null {
  const m = ARCHIVE.exec(name);
  if (m === null) return null;
  // Only the time part's `-` were `:` (…THH-MM-SSZ).
  const iso = (s: string) => s.replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3");
  return { firstIso: iso(m[1]!), lastIso: iso(m[2]!) };
}

/** Whether an archive goes: older than retention, and not the calibration history. */
export function isExpired(name: string, nowS: number): boolean {
  const span = archiveSpan(name);
  if (span === null) return false;
  if (span.firstIso < CALIBRATION_END_ISO) return false;
  return Date.parse(span.lastIso) / 1000 < nowS - RETAIN_DAYS * 86_400;
}

/**
 * Rotate `log` when it is past {@link ROTATE_AT_BYTES}, then prune expired
 * archives. The monitor is the log's only writer and launchd never overlaps
 * its runs, so nothing appends meanwhile.
 */
export function rotateLog(dir: string, log: string, nowS: number): void {
  let size: number;
  try {
    size = statSync(log).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (size > ROTATE_AT_BYTES) {
    const lines = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const cut = splitAt(lines, nowS - KEEP_TAIL_S);
    if (cut > 0) {
      const old = lines.slice(0, cut);
      const iso = (l: string) => (JSON.parse(l) as { iso: string }).iso;
      const archives = join(dir, ARCHIVE_DIR);
      mkdirSync(archives, { recursive: true });
      writeFileSync(
        join(archives, archiveName(iso(old[0]!), iso(old.at(-1)!))),
        gzipSync(old.join("\n") + "\n"),
      );
      const tail = lines.slice(cut);
      writeFileSync(log + ".tmp", tail.length ? tail.join("\n") + "\n" : "");
      renameSync(log + ".tmp", log);
    }
  }
  let names: string[];
  try {
    names = readdirSync(join(dir, ARCHIVE_DIR));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names)
    if (isExpired(name, nowS)) rmSync(join(dir, ARCHIVE_DIR, name));
}
