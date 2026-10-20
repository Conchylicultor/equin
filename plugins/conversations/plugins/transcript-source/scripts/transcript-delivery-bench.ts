// Transcript delivery bench: what one change to a big transcript costs the
// server and the wire, and what opening it costs. Usage:
//   ./singularity run plugins/conversations/plugins/transcript-source/scripts/transcript-delivery-bench.ts <transcript.jsonl> [appends=50]
//
// Replays the transcript the way the watcher reads it: the file minus its last
// `appends` lines read whole, then each remaining line appended and read
// incrementally (`TranscriptLines.append`). Per append it reports the server
// time (append + event build) and the bytes of the rows the change touched —
// what the paged `jsonl-events` value ships as a keyed delta. Rows are keyed as
// `jsonl-viewer`'s `transcriptRows` keys them (a tool call by its tool-use id,
// anything else by its position).
import { TranscriptLines } from "@plugins/conversations/plugins/transcript-source/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

const path = process.argv[2];
if (!path)
  throw new Error(
    "usage: transcript-delivery-bench.ts <transcript.jsonl> [appends]",
  );
const appends = Number(process.argv[3] ?? 50);

const noImages = () => Promise.resolve(null);
const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`;
const kb = (n: number) => `${(n / 1e3).toFixed(1)} KB`;
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;

function rowsById(events: readonly JsonlEvent[]): Map<string, string> {
  const rows = new Map<string, string>();
  const seenToolIds = new Set<string>();
  events.forEach((event, seq) => {
    const id =
      event.kind === "tool-call" &&
      event.toolUseId !== "" &&
      !seenToolIds.has(event.toolUseId)
        ? `tool:${event.toolUseId}`
        : `s${seq}`;
    if (event.kind === "tool-call") seenToolIds.add(event.toolUseId);
    rows.set(id, JSON.stringify({ id, seq, event }));
  });
  return rows;
}

const bytes = await Bun.file(path).bytes();
// Line boundaries: the replay appends the last `appends` complete lines one by one.
const ends: number[] = [];
for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1))
  ends.push(i + 1);
const split = ends[Math.max(0, ends.length - appends - 1)]!;

// Initial read: what opening a cold conversation costs the server.
let t0 = performance.now();
const whole = new TranscriptLines(noImages);
whole.append(path, 0, bytes);
const allEvents = await whole.events();
const fullReadMs = performance.now() - t0;
const heldBytes = JSON.stringify(whole.lines()).length;

// Opening the page: the newest page of rows plus the meta.
const PAGE = 200;
const rows = [...rowsById(allEvents).values()];
const openBytes = rows.slice(-PAGE).reduce((n, r) => n + r.length, 0);
const wholeValueBytes = JSON.stringify(allEvents).length;

// Replay: read up to `split`, then append line by line.
const lines = new TranscriptLines(noImages);
lines.append(path, 0, bytes.subarray(0, split));
let previous = rowsById(await lines.events());
const changeMs: number[] = [];
const changeBytes: number[] = [];
let offset = split;
for (const end of ends.filter((e) => e > split)) {
  t0 = performance.now();
  lines.append(path, offset, bytes.subarray(offset, end));
  const events = await lines.events();
  changeMs.push(performance.now() - t0);
  offset = end;
  const next = rowsById(events);
  let delta = 0;
  for (const [id, json] of next)
    if (previous.get(id) !== json) delta += json.length;
  for (const id of previous.keys()) if (!next.has(id)) delta += id.length;
  changeBytes.push(delta);
  previous = next;
}

console.log(`file: ${path} (${mb(bytes.length)}, ${ends.length} lines)`);
console.log(`events: ${allEvents.length}`);
console.log(`lines held in memory (slim): ${mb(heldBytes)}`);
console.log(`cold read + parse (open, server): ${fullReadMs.toFixed(0)} ms`);
console.log(
  `whole event array (what each change used to push): ${mb(wholeValueBytes)}`,
);
console.log(`open: newest ${PAGE} rows: ${kb(openBytes)}`);
console.log(
  `per appended line (${changeMs.length} replayed): server ${median(changeMs).toFixed(1)} ms median, ${p95(changeMs).toFixed(1)} ms p95; ` +
    `delta ${kb(median(changeBytes))} median, ${kb(p95(changeBytes))} p95, ${kb(Math.max(...changeBytes))} max`,
);
