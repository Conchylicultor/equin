import { z } from "zod";
import { CLIENT_REPORT_SOURCES } from "@plugins/reports/core";
import {
  cappedList,
  cappedRecord,
} from "@plugins/packages/plugins/list-bound/core";
import {
  CLIENT_FAMILIES,
  CLIENT_OSES,
} from "@plugins/reports/plugins/main-thread-stall/core";

/**
 * The report kind a website visitor's error is recorded as on the computer:
 * a site report whose own kind is an error (`crash`, …), or one this computer
 * does not register.
 */
export const WEBSITE_VISITOR_ERROR_KIND = "website-visitor-error";
/**
 * The report kind a website visitor's slowness is recorded as on the
 * computer: a site report whose own kind is a slow op (a slow page load, a
 * main-thread stall, a slow interaction, a render loop). The same payload as
 * the error kind; only where it is read differs (category, bell wording).
 */
export const WEBSITE_VISITOR_SLOWNESS_KIND = "website-visitor-slowness";

/**
 * Every bound of what one imported report may hold. The reduction
 * (`reduceSiteReport`) produces values inside them; the schema refuses
 * anything else, so the two cannot drift silently.
 */
export const VISITOR_ERROR_LIMITS = {
  /** The visitor's error message, one plain line. */
  maxMessage: 300,
  /**
   * The visitor's error type, one plain line: a class name (`TypeError`) or a
   * collector's family (`EndpointError 500 POST /api/x (field)`), which names
   * what failed when the message cannot.
   */
  maxErrorType: 120,
  /** Stack frames kept, each reduced to file / line / column. */
  maxFrames: 15,
  /** A frame's file or the page's path, as a pathname. */
  maxPath: 200,
  /** A stall's frame scripts kept, longest first. */
  maxStallScripts: 5,
  /** A stall's sampled self-time functions kept, heaviest first. */
  maxStallSelf: 5,
  /** Why a stall's stacks are unavailable, one plain line. */
  maxStallReason: 200,
  /** The payload's nesting kept: the payload's own fields are depth 1. */
  maxPayloadDepth: 6,
  /** An object's fields kept, in the site's order. */
  maxPayloadKeys: 30,
  /** An array's items (or a multi-line string's lines) kept. */
  maxPayloadItems: 20,
  /** One string value, one plain line. */
  maxPayloadString: 300,
  /** Values kept over the whole payload (strings, numbers, booleans, nulls). */
  maxPayloadLeaves: 300,
  /** Characters over every string of the payload (the box holds a 4 KB payload). */
  maxPayloadChars: 8_000,
} as const;

/**
 * A pathname of a safe alphabet: no scheme, no host (never `//`, which a
 * browser would read as one), no query, no markup.
 */
export const SAFE_PATHNAME = /^(?!.*\/\/)\/[A-Za-z0-9/._~@-]{0,200}$/;
/** An identifier-shaped value (a kind name). */
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

/**
 * A JS function or invoker name of a safe alphabet (`play`, `Foo.bar`,
 * `MessagePort.onmessage`, `(anonymous)`): a forged payload can name
 * anything, so a name that is not identifier-shaped is not kept.
 */
export const SAFE_FUNCTION_NAME =
  /^(?:[A-Za-z_$][A-Za-z0-9_$.#]{0,79}|\(anonymous\))$/;
/** A LoAF invoker type (`user-callback`, `event-listener`, …). */
export const SAFE_INVOKER_TYPE = /^[a-z][a-z-]{0,31}$/;

/** A DNS hostname. */
export const SAFE_HOSTNAME = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** The visitor page's report source, or `other` for anything unknown. */
export const VISITOR_SOURCES = [...CLIENT_REPORT_SOURCES, "other"] as const;

/**
 * A sanitised plain line as stored: at most `max` code points (not UTF-16
 * units), well-formed (no lone surrogate), no markup character, no line break.
 */
function plainLine(field: string, max: number) {
  return z
    .string()
    .refine((m) => !LONE_SURROGATE.test(m), `${field} holds a lone surrogate`)
    .refine(
      (m) => !/[`<>[\]\n\r]/.test(m),
      `${field} holds markup or a line break`,
    )
    .refine(
      (m) => Array.from(m).length <= max,
      `${field} is over ${max} characters`,
    );
}

const StackFrameSchema = z
  .object({
    file: z.string().regex(SAFE_PATHNAME),
    line: z.number().int().min(1).max(10_000_000),
    column: z.number().int().min(1).max(10_000_000).nullable(),
  })
  .strict();
export type VisitorStackFrame = z.infer<typeof StackFrameSchema>;

const Ms = z.number().int().min(0).max(1_000_000_000);
const FunctionName = z.string().regex(SAFE_FUNCTION_NAME).nullable();

/**
 * A visitor's main-thread stall, reduced to what says what ran and how the
 * freeze was seen — durations, booleans, enums and identifier-shaped function
 * names only (no URL, no route, no message text, no user agent). `unreadable`:
 * the site's payload did not parse as a stall (a payload from a build whose
 * stall schema has since changed).
 */
export const VisitorStallSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unreadable") }).strict(),
  z
    .object({
      kind: z.literal("stall"),
      /** worker: the SharedWorker watchdog saw it; in-tab: the fallback (no SharedWorker). */
      detector: z.enum(["worker", "in-tab"]),
      ended: z.enum(["recovered", "gone", "unknown"]),
      durationMs: Ms,
      durationIsLowerBound: z.boolean(),
      /** The tab's last word before filing (in-tab: when the LoAF entry arrived). */
      visible: z.boolean(),
      focused: z.boolean(),
      /** Long frames that ran inside the stall (0: one task never yielded). */
      framesDuring: z.number().int().min(0).max(1_000_000),
      /** The LoAF entry covering the stall: its time split, when one came back. */
      frame: z
        .object({
          durationMs: Ms,
          blockingDurationMs: Ms,
          renderStartMs: Ms.nullable(),
          styleAndLayoutStartMs: Ms.nullable(),
          /** Summed over the frame's kept (longest) scripts. */
          scriptMs: Ms,
          pauseMs: Ms,
          forcedStyleLayoutMs: Ms,
        })
        .strict()
        .nullable(),
      /** The frame's longest scripts, longest first. */
      scripts: cappedList(
        z
          .object({
            fn: FunctionName,
            invoker: FunctionName,
            invokerType: z.string().regex(SAFE_INVOKER_TYPE).nullable(),
            durationMs: Ms,
            pauseMs: Ms,
            forcedStyleLayoutMs: Ms,
          })
          .strict(),
        { max: VISITOR_ERROR_LIMITS.maxStallScripts },
      ),
      /** The open task mark's source (`port`, `live-state`), when it froze in one. */
      frozenInSource: z.string().regex(SAFE_IDENTIFIER).nullable(),
      /** A click / key press started it. */
      fromInteraction: z.boolean(),
      /**
       * The JS Self-Profiling sample of the stall. `sampledMs` far under
       * `durationMs` means the sampler thread was not running either: the
       * whole process or machine was stopped, not the page busy.
       */
      stacks: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("sampled"),
            sampleIntervalMs: z.number().min(0).max(1_000_000),
            sampledMs: Ms,
            noJsMs: Ms,
            truncated: z.boolean(),
            topSelf: cappedList(
              z.object({ fn: FunctionName, ms: Ms }).strict(),
              { max: VISITOR_ERROR_LIMITS.maxStallSelf },
            ),
          })
          .strict(),
        z
          .object({
            kind: z.literal("unavailable"),
            reason: plainLine(
              "stacks reason",
              VISITOR_ERROR_LIMITS.maxStallReason,
            ),
          })
          .strict(),
      ]),
      /**
       * The stalled tab's JS heap (MB) just before and right after the stall,
       * and its limit: a heap near its limit means a stall with no JS sampled
       * was V8 collecting garbage. Unavailable on a payload filed before it
       * was kept.
       */
      memory: z
        .discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("measured"),
              beforeMb: Ms.nullable(),
              beforeAgoMs: Ms.nullable(),
              afterMb: Ms,
              limitMb: Ms,
            })
            .strict(),
          z
            .object({
              kind: z.literal("unavailable"),
              reason: plainLine(
                "memory reason",
                VISITOR_ERROR_LIMITS.maxStallReason,
              ),
            })
            .strict(),
        ])
        .default({
          kind: "unavailable",
          reason: "filed before stall reports carried the heap",
        }),
      /** Browser family and OS (`unknown` on a payload filed before it was kept). */
      client: z
        .object({ family: z.enum(CLIENT_FAMILIES), os: z.enum(CLIENT_OSES) })
        .strict(),
    })
    .strict(),
]);
export type VisitorStall = z.infer<typeof VisitorStallSchema>;

/**
 * A key of the reduced payload: identifier-shaped, and never one a plain
 * object assignment would read as its prototype.
 */
export const SAFE_PAYLOAD_KEY =
  /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;

/** One value of the reduced payload (see VisitorPayloadSchema). */
export type VisitorPayloadValue =
  | null
  | boolean
  | number
  | string
  | VisitorPayloadValue[]
  | { [key: string]: VisitorPayloadValue };

const PayloadValueSchema: z.ZodType<VisitorPayloadValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    plainLine("payload string", VISITOR_ERROR_LIMITS.maxPayloadString),
    cappedList(PayloadValueSchema, {
      max: VISITOR_ERROR_LIMITS.maxPayloadItems,
    }),
    PayloadFieldsSchema,
  ]),
);

const PayloadFieldsSchema: z.ZodType<{ [key: string]: VisitorPayloadValue }> =
  z.lazy(() =>
    cappedRecord(PayloadValueSchema, {
      max: VISITOR_ERROR_LIMITS.maxPayloadKeys,
    }).refine(
      (r) => Object.keys(r).every((k) => SAFE_PAYLOAD_KEY.test(k)),
      "payload key is not identifier-shaped",
    ),
  );

/** Depth (the fields of an object are one deeper than it) and leaf count. */
function payloadShape(
  v: VisitorPayloadValue,
  depth: number,
): { depth: number; leaves: number; chars: number } {
  if (v === null || typeof v !== "object")
    return {
      depth,
      leaves: 1,
      chars: typeof v === "string" ? Array.from(v).length : 0,
    };
  const children = Array.isArray(v) ? v : Object.values(v);
  let deepest = depth;
  let leaves = 0;
  let chars = 0;
  for (const c of children) {
    const s = payloadShape(c, depth + 1);
    deepest = Math.max(deepest, s.depth);
    leaves += s.leaves;
    chars += s.chars;
  }
  return { depth: deepest, leaves, chars };
}

/**
 * The site's kind payload (`data`) of ANY report kind, reduced structurally
 * — never copied: identifier-shaped keys only; numbers, booleans and nulls as
 * they are; every string one sanitised plain line (as the message: no
 * control, bidi or markup character, URLs on the site's own origin cut to
 * their path and every other URL removed, clamped), a multi-line one (a stack)
 * a list of such lines; nesting, fields, items and values all capped, and what
 * was dropped counted in `omitted`. One generic reduction, so every kind's
 * diagnostic data (a crash's stack and cause, a resize-loop trace, an
 * adaptive-bar's or a render loop's evidence) reaches the local report,
 * including kinds added later, with no per-kind code here.
 */
export const VisitorPayloadSchema = z
  .object({
    fields: PayloadFieldsSchema,
    /** Values dropped: an unsafe key, past a cap or the depth, or not JSON. */
    omitted: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .superRefine((p, ctx) => {
    const s = payloadShape(p.fields, 0);
    if (s.depth > VISITOR_ERROR_LIMITS.maxPayloadDepth)
      ctx.addIssue({
        code: "custom",
        message: `payload nests ${s.depth} deep`,
      });
    if (s.leaves > VISITOR_ERROR_LIMITS.maxPayloadLeaves)
      ctx.addIssue({
        code: "custom",
        message: `payload holds ${s.leaves} values`,
      });
    if (s.chars > VISITOR_ERROR_LIMITS.maxPayloadChars)
      ctx.addIssue({
        code: "custom",
        message: `payload holds ${s.chars} characters`,
      });
  });
export type VisitorPayload = z.infer<typeof VisitorPayloadSchema>;

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
    /** One sanitised plain line, like the message; null when it held none. */
    errorType: plainLine("errorType", VISITOR_ERROR_LIMITS.maxErrorType)
      .refine((t) => t !== "", "errorType is empty (null when there is none)")
      .nullable(),
    message: plainLine("message", VISITOR_ERROR_LIMITS.maxMessage),
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
    /**
     * A `main-thread-stall` report's evidence (see VisitorStallSchema); null
     * for every other kind, and on rows imported before it was kept.
     */
    stall: VisitorStallSchema.nullable().default(null),
    /**
     * The site's kind payload, reduced structurally (VisitorPayloadSchema) —
     * every kind's diagnostic data; null on rows imported before it was kept.
     */
    payload: VisitorPayloadSchema.nullable().default(null),
  })
  .strict();
export type WebsiteVisitorError = z.infer<typeof WebsiteVisitorErrorSchema>;

/** The one plain-text line a report of this kind is summarised by. */
export function websiteVisitorErrorSummary(e: WebsiteVisitorError): string {
  const what = e.errorType ? `${e.errorType}: ${e.message}` : e.message;
  const where = e.hostname ?? e.deploymentId;
  return `${where}${e.path ?? ""} — ${what || "(no message)"}`;
}
