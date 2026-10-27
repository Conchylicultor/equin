import { clientLog } from "@plugins/primitives/plugins/log-channels/web";

const WINDOW = 50;

/**
 * Dev readout of input → frame latency: the time from a mouse press sent to
 * the next screencast frame received, kept as a rolling median over the last
 * {@link WINDOW} samples and logged to the `browser-engine` client-log channel
 * (`~/.equin/worktrees/<wt>/logs/browser-engine.jsonl`). No UI.
 *
 * The next frame after a press is not guaranteed to be caused by it (an
 * animating page streams frames anyway), so this is an upper-bound-ish
 * estimate of interactive latency, not an exact one.
 */
export class LatencyProbe {
  private sentAt: number | null = null;
  private readonly samples: number[] = [];

  /** An input was sent; the next frame closes the sample. */
  inputSent(): void {
    this.sentAt ??= performance.now();
  }

  frameReceived(): void {
    if (this.sentAt === null) return;
    const ms = performance.now() - this.sentAt;
    this.sentAt = null;
    this.samples.push(ms);
    if (this.samples.length > WINDOW) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? ms;
    clientLog(
      "browser-engine",
      `input→frame ${ms.toFixed(0)}ms (median ${median.toFixed(0)}ms over ${sorted.length})`,
    );
  }
}
