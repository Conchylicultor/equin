import { z } from "zod";

// The disk the machine runs on, as the watcher reads it every tick, and the one
// verdict every reader draws from it. On 2026-10-15 a background command whose
// `cat` read its own output file grew it to ~500 GiB over days, and nothing on
// screen said the disk was filling. The watcher already ticks host-wide, so it
// also reads the volume holding the user's home (where ~/.singularity, the repo
// and the temp dirs live) and how fast its free space is falling.

const GIB = 1024 ** 3;

/** One tick's reading of the home volume. */
export const DiskReadingSchema = z.object({
  totalBytes: z.number(),
  freeBytes: z.number(),
  /**
   * How fast free space fell over the last couple of minutes (bytes/s,
   * negative while it grows back); null until that window has filled.
   */
  fillBytesPerSec: z.number().nullable(),
});
export type DiskReading = z.infer<typeof DiskReadingSchema>;

/**
 * What the disk asks of the user, worst first:
 *
 * - `full` — under {@link DISK_FULL_BYTES} free: things will start failing;
 * - `full-soon` — filling fast enough to run out within {@link FULL_SOON_MS};
 * - `filling` — losing at least {@link FILLING_BYTES_PER_SEC} for a sustained
 *   window: something is writing far more than a build does;
 * - `low` — under {@link DISK_LOW_BYTES} free;
 * - `ok`.
 *
 * Discrete on purpose: the health row's summary rides a value pushed to every
 * tab, so it changes when the verdict does, not with every tick's byte count.
 */
export const DiskAlarmSchema = z.enum([
  "ok",
  "low",
  "filling",
  "full-soon",
  "full",
]);
export type DiskAlarm = z.infer<typeof DiskAlarmSchema>;

export const DISK_FULL_BYTES = 10 * GIB;
export const DISK_LOW_BYTES = 50 * GIB;
/** 1 GiB a minute, sustained: no build or install writes like that for minutes. */
export const FILLING_BYTES_PER_SEC = GIB / 60;
export const FULL_SOON_MS = 60 * 60 * 1000;

export function diskAlarmOf(disk: DiskReading): DiskAlarm {
  if (disk.freeBytes < DISK_FULL_BYTES) return "full";
  const rate = disk.fillBytesPerSec;
  if (rate !== null && rate >= FILLING_BYTES_PER_SEC) {
    return (disk.freeBytes / rate) * 1000 < FULL_SOON_MS
      ? "full-soon"
      : "filling";
  }
  if (disk.freeBytes < DISK_LOW_BYTES) return "low";
  return "ok";
}

/** "12 GB", "1.4 GB", "512 MB" — binary units, the way the Finder rounds. */
export function bytesText(bytes: number): string {
  const gib = bytes / GIB;
  if (gib >= 10) return `${String(Math.round(gib))} GB`;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${String(Math.round(bytes / 1024 ** 2))} MB`;
}
