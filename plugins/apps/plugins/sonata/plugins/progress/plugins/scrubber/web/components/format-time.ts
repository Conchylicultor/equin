/**
 * Format elapsed seconds as `m:ss.s` (e.g. 95.4 → "1:35.4"). Rounds to tenths
 * first so a value like 119.98s renders "2:00.0" rather than rolling over into
 * an illegal "1:60.0".
 */
export function formatTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const totalSec = Math.floor(tenths / 10);
  const minutes = Math.floor(totalSec / 60);
  const secs = totalSec - minutes * 60;
  return `${minutes}:${secs.toString().padStart(2, "0")}.${tenths % 10}`;
}
