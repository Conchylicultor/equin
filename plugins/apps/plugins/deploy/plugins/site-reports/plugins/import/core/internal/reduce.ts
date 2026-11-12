import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import type { SiteReportRecord } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import {
  LONE_SURROGATE,
  SAFE_BUILD_ID,
  SAFE_COMMIT,
  SAFE_DEPLOYMENT_ID,
  SAFE_HOSTNAME,
  SAFE_IDENTIFIER,
  SAFE_PATHNAME,
  VISITOR_ERROR_LIMITS as L,
  VISITOR_SOURCES,
  WebsiteVisitorErrorSchema,
  type VisitorStackFrame,
  type WebsiteVisitorError,
} from "./kind";

/** Where the reports come from: this computer's own deployment row. */
export interface SiteContext {
  deploymentId: string;
  /** The deployment's public hostnames: frames on another origin are dropped. */
  hostnames: readonly string[];
}

// Control (Cc) and format (Cf: bidi overrides, zero-width joiners) characters,
// and the line / paragraph separators: none survives into a stored line.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// A URL of any scheme, or a www. host: a link nobody should be one click from.
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S+/giu;
// Markup characters: never rendered as markup anywhere, and stripped anyway so
// a briefing pasted elsewhere cannot become a link, an image or HTML.
const MARKUP = /[`<>[\]]/g;

/**
 * A visitor's message as one plain line: invisible characters gone, URLs
 * removed, markup characters replaced, whitespace collapsed, clamped.
 */
export function sanitizeMessage(raw: string): string {
  // Cut and clamped by CODE POINT, and made well-formed first: a slice through
  // an emoji leaves a lone surrogate, which Postgres refuses in jsonb — one
  // visitor's message would then fail every import after it.
  const line = clampCodePoints(
    raw.replace(new RegExp(LONE_SURROGATE.source, "gu"), "\uFFFD"),
    4 * L.maxMessage,
  )
    .replace(INVISIBLE, " ")
    .replace(URL_LIKE, "(url removed)")
    .replace(MARKUP, "'")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(line);
  return points.length <= L.maxMessage
    ? line
    : `${points.slice(0, L.maxMessage - 1).join("")}…`;
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

/**
 * The structured-data gate between a site's stored report and this
 * computer: everything kept is typed and clamped, and the site's kind payload
 * (`data`) is never copied — only an error type and a stack read out of it.
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
  const path =
    typeof record.path === "string" &&
    record.path.length <= L.maxPath &&
    SAFE_PATHNAME.test(record.path)
      ? record.path
      : null;
  return WebsiteVisitorErrorSchema.parse({
    deploymentId: site.deploymentId,
    hostname: hostnames[0] ?? null,
    siteFingerprint: hashHex(record.fingerprint),
    siteKind: matchOrNull(record.kind, SAFE_IDENTIFIER),
    visitorSource,
    errorType: matchOrNull(record.data.errorType, SAFE_IDENTIFIER),
    message: sanitizeMessage(record.message),
    frames,
    framesOmitted: omitted,
    path,
    buildId: matchOrNull(record.buildId, SAFE_BUILD_ID),
    commit: matchOrNull(record.commit, SAFE_COMMIT),
    siteCount: clampCount(record.count),
    firstSeenAt: new Date(record.firstSeenAt).toISOString(),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
  });
}
