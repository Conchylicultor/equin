// In-process sliding window per fingerprint. A fingerprint firing more than
// THRESHOLD times within WINDOW_MS trips the crashloop flag; while tripped,
// `recordReport` skips the bell notification (the row's write still routes to
// open Reports readers).
// State is ephemeral by design — a process restart breaks the loop anyway.

const WINDOW_MS = 60_000;
const THRESHOLD = 20;

const windows = new Map<string, { start: number; count: number }>();

export function bumpWindowAndCheck(fingerprint: string): boolean {
  const now = Date.now();
  const w = windows.get(fingerprint);
  if (!w || now - w.start > WINDOW_MS) {
    windows.set(fingerprint, { start: now, count: 1 });
    return false;
  }
  w.count++;
  return w.count > THRESHOLD;
}
