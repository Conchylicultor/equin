import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import { pathWithoutSurfaceViews } from "@plugins/primitives/plugins/pane/core";
import type { SiteReportRecord } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import { MainThreadStallPayloadSchema } from "@plugins/reports/plugins/main-thread-stall/core";
import { CodeOriginSchema } from "@plugins/reports/plugins/crash/core";
import {
  LONE_SURROGATE,
  SAFE_BUILD_ID,
  SAFE_COMMIT,
  SAFE_DEPLOYMENT_ID,
  SAFE_FUNCTION_NAME,
  SAFE_HOSTNAME,
  SAFE_IDENTIFIER,
  SAFE_INVOKER_TYPE,
  SAFE_PATHNAME,
  SAFE_PAYLOAD_KEY,
  VISITOR_ERROR_LIMITS as L,
  VISITOR_SOURCES,
  WebsiteVisitorErrorSchema,
  type VisitorPayload,
  type VisitorPayloadValue,
  type VisitorStackFrame,
  type VisitorStall,
  type WebsiteVisitorError,
} from "./kind";

/** Where the reports come from: this computer's own deployment row. */
export interface SiteContext {
  deploymentId: string;
  /** The deployment's public hostnames: frames on another origin are dropped. */
  hostnames: readonly string[];
}

/**
 * The visitor page's path as stored: without its surface view keys
 * (`;view.<surface>=…` — a DataView filter rides there as a base64 blob, and
 * the channel may have sent it percent-encoded and cut mid-blob), then kept
 * only when it is a safe pathname. Before, any page showing a filtered view
 * (report-1795037821-l4a4xo: the demo's Places) arrived with no path at all.
 */
export function reducePagePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
  }
  const path = pathWithoutSurfaceViews(decoded);
  return path.length <= L.maxPath && SAFE_PATHNAME.test(path) ? path : null;
}

// Control (Cc) and format (Cf: bidi overrides, zero-width joiners) characters,
// and the line / paragraph separators: none survives into a stored line.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// A URL of any scheme, or a www. host: a link nobody should be one click from.
// No leading word boundary: `_https://…` or `0www.…` must not slip past it.
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/\S*|www\.\S+/giu;
// Markup characters: never rendered as markup anywhere, and stripped anyway so
// a briefing pasted elsewhere cannot become a link, an image or HTML.
const MARKUP = /[`<>[\]]/g;

/**
 * A visitor's message as one plain line: invisible characters gone, URLs
 * removed, markup characters replaced, whitespace collapsed, clamped.
 */
export function sanitizeMessage(raw: string): string {
  return sanitizeLine(raw, L.maxMessage);
}

/** Visitor text as one plain line of at most `max` code points (see sanitizeMessage). */
function sanitizeLine(raw: string, max: number): string {
  // Cut and clamped by CODE POINT, and made well-formed first: a slice through
  // an emoji leaves a lone surrogate, which Postgres refuses in jsonb — one
  // visitor's message would then fail every import after it.
  const line = clampCodePoints(
    raw.replace(new RegExp(LONE_SURROGATE.source, "gu"), "\uFFFD"),
    4 * max,
  )
    .replace(INVISIBLE, " ")
    .replace(URL_LIKE, "(url removed)")
    .replace(MARKUP, "'")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(line);
  return points.length <= max ? line : `${points.slice(0, max - 1).join("")}…`;
}

function clampCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

function matchOrNull(value: unknown, re: RegExp): string | null {
  return typeof value === "string" && re.test(value) ? value : null;
}

// One frame location: an optional origin, a path, a line and a column — the
// last `(<url>:<line>:<col>)` / `@<url>:<line>:<col>` / `at <url>:<line>:<col>`
// on a stack line. Function names are not kept: a forged stack could carry any.
// The location must start the line or follow a space, `(` or `@`, so a path
// inside another scheme (`chrome-extension://…`, `javascript://…`) is never
// read as the site's own.
const FRAME =
  /(?:^|[\s(@])(?:(https?):\/\/([^/\s:@]+)(?::\d+)?)?(\/(?!\/)[^\s():]*):(\d+)(?::(\d+))?\)?\s*$/;

/**
 * A stack's frames reduced to `{ file, line, column }` on the site's own
 * origin (or relative), at most `maxFrames`; every other line is counted.
 */
export function reduceStack(
  stack: unknown,
  hostnames: readonly string[],
): { frames: VisitorStackFrame[]; omitted: number } {
  if (typeof stack !== "string") return { frames: [], omitted: 0 };
  const own = new Set(hostnames.map((h) => h.toLowerCase()));
  const frames: VisitorStackFrame[] = [];
  let omitted = 0;
  // Bounded before splitting: the site clamps strings already, this holds
  // whatever it sent to the same scale.
  const lines = stack.slice(0, 20_000).split("\n");
  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    const m = FRAME.exec(text);
    if (!m) {
      // The first line of a V8 stack is the message itself, not a frame.
      if (/^\s*at\s|@/.test(text)) omitted++;
      continue;
    }
    const [, , host, file, line, column] = m;
    const onOwnOrigin = host === undefined || own.has(host.toLowerCase());
    if (
      !onOwnOrigin ||
      !SAFE_PATHNAME.test(file!) ||
      file!.length > L.maxPath ||
      frames.length >= L.maxFrames
    ) {
      omitted++;
      continue;
    }
    const lineNo = Number(line);
    const colNo = column === undefined ? null : Number(column);
    if (
      !Number.isSafeInteger(lineNo) ||
      lineNo < 1 ||
      lineNo > 10_000_000 ||
      (colNo !== null && (colNo < 1 || colNo > 10_000_000))
    ) {
      omitted++;
      continue;
    }
    frames.push({ file: file!, line: lineNo, column: colNo });
  }
  return { frames, omitted: Math.min(omitted, 10_000) };
}

function clampCount(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 1_000_000_000);
}

/** The site's kind name of a main-thread stall (reports/main-thread-stall). */
const STALL_KIND = "main-thread-stall";

/** A duration as stored: a whole, non-negative, bounded number of ms. */
function ms(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), 1_000_000_000);
}

/** A function name from a sampled frame label (`name (url:line:col)`) or a LoAF field. */
function functionName(raw: string): string | null {
  const name = raw.split(" (")[0]!.trim();
  return SAFE_FUNCTION_NAME.test(name) ? name : null;
}

/**
 * A visitor's stall payload reduced to its evidence (VisitorStallSchema):
 * how it was seen and ended, the covering frame's time split, its longest
 * scripts and sampled self-time functions by name, the browser family and OS.
 * The payload was validated by the site against the stall kind's schema; one
 * that no longer parses (an older build's) is `unreadable`, never guessed at.
 */
export function reduceStall(data: unknown): VisitorStall {
  const parsed = MainThreadStallPayloadSchema.safeParse(data);
  if (!parsed.success) return { kind: "unreadable" };
  const d = parsed.data;
  const f = d.stallFrame;
  const scripts = f?.scripts ?? [];
  const sum = (pick: (s: (typeof scripts)[number]) => number): number =>
    ms(scripts.reduce((total, s) => total + pick(s), 0));
  return {
    kind: "stall",
    detector: d.detector,
    ended: d.ended,
    durationMs: ms(d.durationMs),
    durationIsLowerBound: d.durationIsLowerBound,
    visible: d.visible,
    focused: d.focused,
    framesDuring: Math.min(Math.max(0, Math.floor(d.framesDuring)), 1_000_000),
    frame: f
      ? {
          durationMs: ms(f.durationMs),
          blockingDurationMs: ms(f.blockingDurationMs),
          renderStartMs: f.renderStartMs === null ? null : ms(f.renderStartMs),
          styleAndLayoutStartMs:
            f.styleAndLayoutStartMs === null
              ? null
              : ms(f.styleAndLayoutStartMs),
          scriptMs: sum((s) => s.durationMs),
          pauseMs: sum((s) => s.pauseDurationMs),
          forcedStyleLayoutMs: sum((s) => s.forcedStyleAndLayoutDurationMs),
        }
      : null,
    scripts: [...scripts]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, L.maxStallScripts)
      .map((s) => ({
        fn: s.sourceFunctionName ? functionName(s.sourceFunctionName) : null,
        invoker: functionName(s.invoker),
        invokerType: SAFE_INVOKER_TYPE.test(s.invokerType)
          ? s.invokerType
          : null,
        durationMs: ms(s.durationMs),
        pauseMs: ms(s.pauseDurationMs),
        forcedStyleLayoutMs: ms(s.forcedStyleAndLayoutDurationMs),
      })),
    frozenInSource: d.frozenIn
      ? matchOrNull(d.frozenIn.source, SAFE_IDENTIFIER)
      : null,
    fromInteraction: d.interaction !== null,
    stacks:
      d.stacks.kind === "sampled"
        ? {
            kind: "sampled",
            sampleIntervalMs: Math.min(
              Math.max(0, d.stacks.sampleIntervalMs),
              1_000_000,
            ),
            sampledMs: ms(d.stacks.sampledMs),
            noJsMs: ms(d.stacks.noJsMs),
            truncated: d.stacks.truncated,
            topSelf: d.stacks.topSelf
              .slice(0, L.maxStallSelf)
              .map((t) => ({ fn: functionName(t.frame), ms: ms(t.ms) })),
          }
        : {
            kind: "unavailable",
            reason:
              sanitizeLine(d.stacks.reason, L.maxStallReason) || "(none given)",
          },
    memory:
      d.memory.kind === "measured"
        ? {
            kind: "measured",
            beforeMb: d.memory.beforeMb === null ? null : ms(d.memory.beforeMb),
            beforeAgoMs:
              d.memory.beforeAgoMs === null ? null : ms(d.memory.beforeAgoMs),
            afterMb: ms(d.memory.afterMb),
            limitMb: ms(d.memory.limitMb),
          }
        : {
            kind: "unavailable",
            reason:
              sanitizeLine(d.memory.reason, L.maxStallReason) || "(none given)",
          },
    client: d.client,
  };
}

// An http(s) URL up to its end, a trailing stack position (`:12:3`) apart.
// No leading word boundary: `_https://…` or `0https://…` is a URL too.
const HTTP_URL = /https?:\/\/[^\s()]*?(?=(?::\d+){0,2}(?:[\s()]|$))/giu;

/**
 * A URL on the site's own origin as its path — parsed as a browser would (so
 * userinfo, `//` or a URL in its query never passes for the site's own), its
 * query and fragment dropped — or null to leave it for removal.
 */
function ownPath(url: string, own: ReadonlySet<string>): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  if (u.username || u.password || !own.has(u.hostname.toLowerCase()))
    return null;
  return SAFE_PATHNAME.test(u.pathname) && u.pathname.length <= L.maxPath
    ? u.pathname
    : null;
}

/**
 * One string of the payload as one plain line: a URL on the site's own origin
 * cut to its path (`at f (https://equin.ai/a.js:1:2)` → `at f (/a.js:1:2)`),
 * then sanitised like the message — every other URL removed.
 */
function payloadLine(raw: string, own: ReadonlySet<string>): string {
  return sanitizeLine(
    raw.replace(HTTP_URL, (url: string) => ownPath(url, own) ?? url),
    L.maxPayloadString,
  );
}

/**
 * The site's kind payload reduced structurally (VisitorPayloadSchema): keys
 * matched, scalars typed, strings sanitised one line each (a multi-line one,
 * a stack, as a list of lines), every cap applied in the site's order and
 * every value dropped counted. Generic over every report kind: what a kind
 * carries for its diagnosis reaches the local report without code here naming
 * the kind.
 */
export function reducePayload(
  data: Record<string, unknown>,
  hostnames: readonly string[],
): VisitorPayload {
  const own = new Set(hostnames.map((h) => h.toLowerCase()));
  let leaves = 0;
  let chars = 0;
  let omitted = 0;

  function leafString(line: string): string | undefined {
    const n = Array.from(line).length;
    if (chars + n > L.maxPayloadChars) {
      omitted++;
      return undefined;
    }
    chars += n;
    leaves++;
    return line;
  }

  // `depth` is the depth of the value being reduced (the payload's own fields
  // are 1). Undefined: the value is dropped (and counted).
  function value(v: unknown, depth: number): VisitorPayloadValue | undefined {
    if (depth > L.maxPayloadDepth || leaves >= L.maxPayloadLeaves) {
      omitted++;
      return undefined;
    }
    if (v === null || typeof v === "boolean") {
      leaves++;
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        omitted++;
        return undefined;
      }
      leaves++;
      return v;
    }
    if (typeof v === "string") {
      const lines = v
        .slice(0, 20_000)
        .split(/\r?\n/)
        .map((l) => payloadLine(l, own))
        .filter((l) => l !== "");
      if (lines.length <= 1) return leafString(lines[0] ?? "");
      return list(lines, depth);
    }
    if (Array.isArray(v)) return list(v, depth);
    if (typeof v === "object")
      return fields(v as Record<string, unknown>, depth);
    // undefined, a function, a bigint: not JSON.
    omitted++;
    return undefined;
  }

  function list(
    items: readonly unknown[],
    depth: number,
  ): VisitorPayloadValue[] {
    const out: VisitorPayloadValue[] = [];
    for (const item of items) {
      if (out.length >= L.maxPayloadItems) {
        omitted++;
        continue;
      }
      const r = value(item, depth + 1);
      if (r !== undefined) out.push(r);
    }
    return out;
  }

  function fields(
    obj: Record<string, unknown>,
    depth: number,
  ): { [key: string]: VisitorPayloadValue } {
    const out: [string, VisitorPayloadValue][] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (out.length >= L.maxPayloadKeys || !SAFE_PAYLOAD_KEY.test(k)) {
        omitted++;
        continue;
      }
      const r = value(v, depth + 1);
      if (r !== undefined) out.push([k, r]);
    }
    return Object.fromEntries(out);
  }

  return { fields: fields(data, 0), omitted: Math.min(omitted, 1_000_000) };
}

/**
 * The structured-data gate between a site's stored report and this
 * computer: everything kept is typed and clamped, and the site's kind payload
 * (`data`) is never copied — it is reduced structurally (reducePayload), and
 * an error type, a stack's frames and a stall's evidence are read out of it.
 * The result is parsed with the kind's strict schema before it is returned,
 * so a value this function let through by mistake fails here, loudly, rather
 * than being stored.
 */
export function reduceSiteReport(
  record: SiteReportRecord,
  site: SiteContext,
): WebsiteVisitorError {
  if (!SAFE_DEPLOYMENT_ID.test(site.deploymentId)) {
    throw new Error(
      `reduceSiteReport: ${JSON.stringify(site.deploymentId)} is not a deployment id`,
    );
  }
  const hostnames = site.hostnames.filter((h) => SAFE_HOSTNAME.test(h));
  const { frames, omitted } = reduceStack(record.data.stack, hostnames);
  const visitorSource = (VISITOR_SOURCES as readonly string[]).includes(
    record.source,
  )
    ? (record.source as WebsiteVisitorError["visitorSource"])
    : "other";
  const path = reducePagePath(record.path);
  return WebsiteVisitorErrorSchema.parse({
    deploymentId: site.deploymentId,
    hostname: hostnames[0] ?? null,
    siteFingerprint: hashHex(record.fingerprint),
    siteKind: matchOrNull(record.kind, SAFE_IDENTIFIER),
    visitorSource,
    // Sanitised like the message, not matched against an identifier: a
    // collector's type names what failed (`EndpointError 500 GET /api/x`),
    // and dropping it left a report with an empty message nothing to say.
    errorType:
      typeof record.data.errorType === "string"
        ? sanitizeLine(record.data.errorType, L.maxErrorType) || null
        : null,
    message: sanitizeMessage(record.message),
    frames,
    framesOmitted: omitted,
    path,
    buildId: matchOrNull(record.buildId, SAFE_BUILD_ID),
    commit: matchOrNull(record.commit, SAFE_COMMIT),
    siteCount: clampCount(record.count),
    firstSeenAt: new Date(record.firstSeenAt).toISOString(),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    stall: record.kind === STALL_KIND ? reduceStall(record.data) : null,
    payload: reducePayload(record.data, hostnames),
    codeOrigin: CodeOriginSchema.safeParse(record.data.codeOrigin).data ?? null,
  });
}
