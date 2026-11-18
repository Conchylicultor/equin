import type { ReportBody } from "./report-body";

// A report is filed from a failure, and a failure is when it matters most —
// yet the failures that list everything they touched (a host boot naming every
// plugin it lost, with its URL, then the stack repeating it) are the ones whose
// report is too large to send. A browser refuses a keepalive request over
// 64 KB outright ("Failed to fetch"), and the site's public intake refuses a
// body over its own bounds; either way the report used to vanish whole.
//
// So every report is fitted to its channel's bounds before it is sent: too
// long a string is cut in its middle, the cut saying so in place
// ("… [N chars trimmed] …") — a stack keeps its frames, top first, and loses
// the message it opens with; too long an array keeps its first items; and a
// payload still too large with every string short drops its largest fields —
// each structural cut named in the message. A report always fits, and a
// trimmed one always says it was trimmed.

/** The bounds one report channel sends within. */
export interface ReportSizeLimits {
  /** The one-line summary, in characters. */
  maxMessage: number;
  /** The kind payload, serialized as JSON, in UTF-8 bytes. */
  maxDataBytes: number;
  /** One string inside the payload, in characters. */
  maxDataString: number;
  /** The page URL, in characters. */
  maxUrl: number;
}

/**
 * The page's reports engine (`POST /api/reports`), sent as a keepalive fetch:
 * the browser refuses one over 64 KB, and every keepalive request in flight
 * shares that budget — so one report stays at a fraction of it (about 20 KB
 * at most), and a few sent together still fit. The message bound is the
 * engine's display bound (record-report's MESSAGE_MAX).
 */
export const REPORT_SIZE_LIMITS: ReportSizeLimits = {
  maxMessage: 4_000,
  maxDataBytes: 12 * 1024,
  maxDataString: 6_000,
  maxUrl: 2_048,
};

/** Below this, a cut has no room to say so: the string is cut plainly. */
const MIN_MARKED = 64;

// A stack frame line: V8's `at fn (url:1:2)`, or Safari / Firefox's
// `fn@url:1:2` (the forms crash-kind's normalizeFrames reads).
const FRAME_LINE = /^\s*(?:at\s|[^@\s]*@\S+$)/;

// A cut never splits a surrogate pair: half an emoji is not valid Unicode,
// and Postgres refuses it in jsonb — the report would be lost on insert.
function snapEnd(text: string, end: number): number {
  const c = text.charCodeAt(end - 1);
  return c >= 0xd800 && c <= 0xdbff ? end - 1 : end;
}
function snapStart(text: string, start: number): number {
  const c = text.charCodeAt(start);
  return c >= 0xdc00 && c <= 0xdfff ? start + 1 : start;
}

const countOf = (cut: number) => cut.toLocaleString("en-US");

/** `text` cut in its middle: a third of the room for its head, the rest for its tail. */
function trimMiddle(text: string, max: number): string {
  const multiline = text.includes("\n");
  const markerFor = (cut: number) =>
    multiline
      ? `\n… [${countOf(cut)} chars trimmed] …\n`
      : ` … [${countOf(cut)} chars trimmed] … `;
  // The marker's length depends on the count it names: size it for the
  // largest count it can name (the whole text), so the result always fits.
  const keep = max - markerFor(text.length).length;
  const headBudget = Math.floor(keep / 3);
  const tailBudget = keep - headBudget;
  let headEnd = headBudget;
  let tailStart = text.length - tailBudget;
  if (multiline) {
    const nl = text.lastIndexOf("\n", headEnd);
    if (nl > headBudget / 2) headEnd = nl;
    const tl = text.indexOf("\n", tailStart);
    if (tl !== -1 && tl + 1 < tailStart + tailBudget / 2) tailStart = tl + 1;
  }
  headEnd = snapEnd(text, headEnd);
  tailStart = snapStart(text, tailStart);
  return (
    text.slice(0, headEnd) +
    markerFor(tailStart - headEnd) +
    text.slice(tailStart)
  );
}

/** `text`'s first lines, cut at its end. */
function trimTail(text: string, max: number): string {
  const markerFor = (cut: number) => `\n… [${countOf(cut)} chars trimmed]`;
  const keep = max - markerFor(text.length).length;
  const nl = text.lastIndexOf("\n", keep);
  const end = snapEnd(text, nl > keep / 2 ? nl : keep);
  return text.slice(0, end) + markerFor(text.length - end);
}

/**
 * A stack cut where it costs least: its frames — what a crash is identified
 * by, the top ones first — are kept, and the message the stack opens with
 * (which the report carries anyway) is cut in its middle; frames too many to
 * fit lose their bottom ones.
 */
function trimStack(lines: string[], firstFrame: number, max: number): string {
  const head = lines.slice(0, firstFrame).join("\n");
  const frames = lines.slice(firstFrame).join("\n");
  const headMax =
    frames.length + 1 + Math.min(head.length, MIN_MARKED) <= max
      ? max - frames.length - 1
      : Math.floor(max / 4);
  const keptHead =
    head === "" ? "" : trimText(head, Math.max(MIN_MARKED, headMax));
  const room = max - keptHead.length - (keptHead === "" ? 0 : 1);
  const keptFrames = frames.length <= room ? frames : trimTail(frames, room);
  return keptHead === "" ? keptFrames : `${keptHead}\n${keptFrames}`;
}

/**
 * `text` at most `max` characters, never splitting a character: whole when it
 * fits; a stack with its frames kept (trimStack); anything else cut in its
 * middle, around a marker naming how much was cut, snapped to line breaks
 * when it has them.
 */
export function trimText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  if (max < MIN_MARKED) return `${text.slice(0, snapEnd(text, max - 1))}…`;
  if (text.includes("\n")) {
    const lines = text.split("\n");
    const firstFrame = lines.findIndex((l) => FRAME_LINE.test(l));
    if (firstFrame !== -1 && max >= 2 * MIN_MARKED) {
      return trimStack(lines, firstFrame, max);
    }
  }
  return trimMiddle(text, max);
}

const encoder = new TextEncoder();
function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

// Past this depth a value is kept as it is: a collector's payload is a few
// levels deep, and a deeper one that is still too large is caught by the
// field drop below.
const MAX_DEPTH = 12;

function clampValue(
  value: unknown,
  maxString: number,
  maxItems: number,
  path: string,
  cuts: string[],
  depth: number,
): unknown {
  if (typeof value === "string") return trimText(value, maxString);
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > maxItems) {
      cuts.push(`${path} kept ${maxItems} of ${value.length} items`);
    }
    return value
      .slice(0, maxItems)
      .map((v, i) =>
        clampValue(v, maxString, maxItems, `${path}[${i}]`, cuts, depth + 1),
      );
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      clampValue(v, maxString, maxItems, `${path}.${k}`, cuts, depth + 1),
    ]),
  );
}

/**
 * `data` within `maxBytes` serialized: whole when it fits; else every string
 * and array clamped, tighter at each step until it fits; else (still too
 * large at the tightest step — many fields, or very deep) its largest
 * top-level fields dropped until it does. Returns the structural cuts made,
 * for the message to name; a trimmed string names its own cut.
 */
function fitData(
  data: Record<string, unknown>,
  limits: ReportSizeLimits,
): { data: Record<string, unknown>; cuts: string[] } {
  if (jsonBytes(data) <= limits.maxDataBytes) return { data, cuts: [] };
  const steps: [number, number][] = [
    [limits.maxDataString, 100],
    [Math.min(limits.maxDataString, 2_000), 25],
    [Math.min(limits.maxDataString, 500), 10],
    [Math.min(limits.maxDataString, 120), 3],
  ];
  let fitted: Record<string, unknown> = data;
  let cuts: string[] = [];
  for (const [maxString, maxItems] of steps) {
    cuts = [];
    fitted = clampValue(data, maxString, maxItems, "data", cuts, 0) as Record<
      string,
      unknown
    >;
    if (jsonBytes(fitted) <= limits.maxDataBytes) return { data: fitted, cuts };
  }
  const bySize = Object.entries(fitted)
    .map(([k, v]) => ({ k, size: jsonBytes({ [k]: v }) }))
    .sort((a, b) => b.size - a.size);
  const kept = { ...fitted };
  for (const { k } of bySize) {
    if (jsonBytes(kept) <= limits.maxDataBytes) break;
    delete kept[k];
    cuts.push(`data.${k} dropped`);
  }
  return { data: kept, cuts };
}

/**
 * The report fitted to a channel's bounds: unchanged when it already fits;
 * otherwise trimmed (see the module comment) and saying so — in each cut
 * string, and in the message for a cut array or a dropped field.
 */
export function fitReportBody<B extends ReportBody>(
  body: B,
  limits: ReportSizeLimits,
): B {
  const { data, cuts } = fitData(body.data, limits);
  const note =
    cuts.length === 0
      ? ""
      : ` [report trimmed to fit its size limit: ${trimText(cuts.join("; "), 400)}]`;
  const message =
    note === ""
      ? trimText(body.message, limits.maxMessage)
      : trimText(body.message, Math.max(0, limits.maxMessage - note.length)) +
        note;
  return {
    ...body,
    message,
    data,
    // Cut plainly: a URL with a marker inside it is no longer a URL.
    url:
      body.url == null
        ? body.url
        : body.url.slice(0, snapEnd(body.url, limits.maxUrl)),
    userAgent:
      body.userAgent == null ? body.userAgent : trimText(body.userAgent, 512),
  };
}
