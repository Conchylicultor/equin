import { z } from "zod";
import { CLIENT_REPORT_SOURCES } from "@plugins/reports/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/** The report kind a website visitor's error is recorded as on the computer. */
export const WEBSITE_VISITOR_ERROR_KIND = "website-visitor-error";

/**
 * Every bound of what one imported report may hold. The reduction
 * (`reduceSiteReport`) produces values inside them; the schema refuses
 * anything else, so the two cannot drift silently.
 */
export const VISITOR_ERROR_LIMITS = {
  /** The visitor's error message, one plain line. */
  maxMessage: 300,
  /** Stack frames kept, each reduced to file / line / column. */
  maxFrames: 15,
  /** A frame's file or the page's path, as a pathname. */
  maxPath: 200,
} as const;

/**
 * A pathname of a safe alphabet: no scheme, no host (never `//`, which a
 * browser would read as one), no query, no markup.
 */
export const SAFE_PATHNAME = /^\/(?!.*\/\/)[A-Za-z0-9/._~@-]{0,200}$/;
/** An identifier-shaped value (an error's type, a kind name). */
export const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/;
/** A build id. */
export const SAFE_BUILD_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** A commit sha. */
export const SAFE_COMMIT = /^[0-9a-f]{7,64}$/;
/** A deployment id (`dpl-<stamp>-<suffix>`). */
export const SAFE_DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * A lone UTF-16 surrogate (half an emoji): Postgres refuses one in jsonb, so a
 * stored string never holds one. (`\p{Cs}` in a `u` regex matches only an
 * unpaired surrogate; a pair is one code point.)
 */
export const LONE_SURROGATE = /\p{Cs}/u;

/** A DNS hostname. */
export const SAFE_HOSTNAME = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** The visitor page's report source, or `other` for anything unknown. */
export const VISITOR_SOURCES = [...CLIENT_REPORT_SOURCES, "other"] as const;

const StackFrameSchema = z
  .object({
    file: z.string().regex(SAFE_PATHNAME),
    line: z.number().int().min(1).max(10_000_000),
    column: z.number().int().min(1).max(10_000_000).nullable(),
  })
  .strict();
export type VisitorStackFrame = z.infer<typeof StackFrameSchema>;

/**
 * One website visitor's error as stored on the computer — typed, clamped
 * fields only. Nothing the site sent is copied as-is: the site's kind payload
 * is never stored, the message is one sanitised plain line, the stack is
 * pathnames and numbers. See the plugin's CLAUDE.md for the threat model.
 */
export const WebsiteVisitorErrorSchema = z
  .object({
    deploymentId: z.string().regex(SAFE_DEPLOYMENT_ID),
    /** The site's first public hostname, from this computer's own deployment row. */
    hostname: z.string().regex(SAFE_HOSTNAME).nullable(),
    /** The site's own fingerprint, hashed (`hashHex`): an identity, never shown. */
    siteFingerprint: z.string().regex(/^[0-9a-f]{28}$/),
    /** The report kind the visitor's page filed on the site (`crash`, …). */
    siteKind: z.string().regex(SAFE_IDENTIFIER).nullable(),
    visitorSource: z.enum(VISITOR_SOURCES),
    errorType: z.string().regex(SAFE_IDENTIFIER).nullable(),
    // Code points, not UTF-16 units; and well-formed (no lone surrogate).
    message: z
      .string()
      .refine((m) => !LONE_SURROGATE.test(m), "message holds a lone surrogate")
      .refine(
        (m) => Array.from(m).length <= VISITOR_ERROR_LIMITS.maxMessage,
        `message is over ${VISITOR_ERROR_LIMITS.maxMessage} characters`,
      ),
    frames: cappedList(StackFrameSchema, {
      max: VISITOR_ERROR_LIMITS.maxFrames,
    }),
    /** Frames dropped: past the cap, off the site's origin, or unparseable. */
    framesOmitted: z.number().int().min(0).max(10_000),
    path: z.string().regex(SAFE_PATHNAME).nullable(),
    buildId: z.string().regex(SAFE_BUILD_ID).nullable(),
    commit: z.string().regex(SAFE_COMMIT).nullable(),
    /** Occurrences the site counted for this fingerprint (its own total). */
    siteCount: z.number().int().min(1).max(1_000_000_000),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
  })
  .strict();
export type WebsiteVisitorError = z.infer<typeof WebsiteVisitorErrorSchema>;

/** The one plain-text line a report of this kind is summarised by. */
export function websiteVisitorErrorSummary(e: WebsiteVisitorError): string {
  const what = e.errorType ? `${e.errorType}: ${e.message}` : e.message;
  const where = e.hostname ?? e.deploymentId;
  return `${where}${e.path ?? ""} — ${what || "(no message)"}`;
}
