import { defineCard } from "../kit/types";

const ROWS = [
  ["Backs up your data", "every night", "6 h ago"],
  ["Fetches new mail", "every 5 min", "2 min ago"],
  ["Indexes your files", "when a file changes", "1 h ago"],
  ["Deletes old logs", "every night", "7 h ago"],
] as const;
const X = 4;
const W = 298;
const TOP = 26;
const RH = 34; // the list
const C3 = W - 10; // the "last run" column (end)

/**
 * Background monitoring: a simplified Debug → Background activity. Everything the app runs on its own, each with
 * what it does in words, when it runs (under it), and how its last run went. One row runs at a time, on a loop.
 */
export const backgroundCard = defineCard({
  states: ROWS.length, // which row just ran
  autoplay: { seq: ROWS.map((_, i) => i), every: 2400 },
  render: (k) => {
    let s =
      k.text(X + 22, 14, "What it does", "k-cap", "start") +
      k.text(C3, 14, "Last run", "k-cap", "end");
    s += `<rect x="${X}" y="${TOP - 4}" width="${W - X}" height="${ROWS.length * RH + 8}" rx="${k.R.md}" class="k-box"/>`;
    ROWS.forEach(([what, when, last], i) => {
      const y = TOP + i * RH;
      const m = y + RH / 2;
      if (i)
        s += `<path d="M${X + 10} ${y} H${W - 10}" class="k-ink k-faint"/>`;
      const others = ROWS.map((_, j) => j)
        .filter((j) => j !== i)
        .join(" ");
      // the row that just ran: lit, its dot pulsing, its last run now
      s +=
        `<g data-in="${i}"><rect x="${X + 4}" y="${y + 2}" width="${W - X - 8}" height="${RH - 4}" rx="${k.R.sm}" class="k-lit"/>` +
        `<g class="k-in" style="--d:.5s">${k.text(C3, m + 3.5, "✓ just now", "k-ts k-ta", "end")}</g></g>`;
      s += `<circle cx="${X + 12}" cy="${m}" r="3.5" class="k-accf k-sw-pulse" data-on="${i}"/>`;
      s += `<g data-in="${others}">${k.text(C3, m + 3.5, last, "k-ts k-mute", "end")}</g>`;
      s +=
        k.text(X + 22, m - 1.5, what, "k-tb", "start") +
        k.text(X + 22, m + 10, when, "k-ts k-mute", "start");
    });
    return k.svg(TOP + ROWS.length * RH + 6, s);
  },
});
