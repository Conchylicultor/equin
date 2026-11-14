import type { EventLine } from "./entities";

/**
 * When a role's gathered events go out. The first event after a quiet period
 * goes at once; a message starts a quiet period of `gapMs`, and what lands in
 * it waits for its end.
 *
 * `lastMessageAt` is the role's last message (any outcome), null when it has
 * none. Answers `now` when it may go now, else the end of the quiet period.
 */
export function nextMessageAt(
  lastMessageAt: Date | null,
  gapMs: number,
  now: Date,
): Date {
  if (lastMessageAt === null) return now;
  const end = new Date(lastMessageAt.getTime() + gapMs);
  return end.getTime() <= now.getTime() ? now : end;
}

/** One summarized line: `×3 crash · Uncaught TypeError … (rep-…)`. */
export function renderEventLine(l: EventLine): string {
  return `×${l.count} ${l.kind} · ${l.title}${l.ref === null ? "" : ` (${l.ref})`}`;
}

/**
 * A message's text: a header naming how much it folds, then one line per
 * event — always a summary, never a whole report (the ref says where to read
 * one).
 */
export function renderEventMessage(
  lines: readonly EventLine[],
  streamLabel: (id: string) => string,
  since: Date | null,
): string {
  const events = lines.reduce((n, l) => n + l.count, 0);
  const streams = [...new Set(lines.map((l) => streamLabel(l.streamId)))];
  const head =
    `${streams.join(", ")} — ${events} ${events === 1 ? "event" : "events"}` +
    (lines.length > 1 ? ` · ${lines.length} distinct` : "") +
    (since === null ? "" : ` since ${since.toISOString().slice(11, 16)} UTC`);
  return [head, ...lines.map((l) => `- ${renderEventLine(l)}`)].join("\n");
}
