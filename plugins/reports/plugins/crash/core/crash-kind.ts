import { z } from "zod";
import {
  normalizeMessage,
  type ReportFingerprintContext,
} from "@plugins/reports/core";
import { UiContextMetaSchema } from "@plugins/primitives/plugins/ui-context/core";
import { ResizeLoopTraceSchema } from "./resize-loop";

// The crash report payload, stored in the generic `data` jsonb column and
// validated on ingest by the crash ReportKind. Mirrors the crash fields that
// previously lived as dedicated columns on the reports table.
export const CrashPayloadSchema = z.object({
  errorType: z.string().nullable().optional(),
  stack: z.string().nullable().optional(),
  componentStack: z.string().nullable().optional(),
  // For react-boundary crashes: which plugin slot rendered the throwing tree
  // (e.g. "Shell.Toolbar") and which contribution inside it (the plugin id or a
  // human label). Omitted for window-level errors — we don't know then.
  slot: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  // The composition lineage of the crashed subtree, collected by the boundary's
  // fallback from its own mount point. Kept ALONGSIDE slot/label rather than
  // replacing them: those are the boundary's own view, available with no DOM
  // walk and no opt-in middleware installed. Absent for the window-level and
  // wedge sources, which have no DOM position to walk from.
  uiContext: UiContextMetaSchema.nullable().optional(),
  // For a "ResizeObserver loop" window error, which has no stack: the
  // observer callbacks around it (./resize-loop.ts). Not part of the
  // fingerprint — every occurrence stays on the message's row.
  resizeLoop: ResizeLoopTraceSchema.nullable().optional(),
});
export type CrashPayload = z.infer<typeof CrashPayloadSchema>;

// Crash fingerprint = sha256(<identity material>), first 16 hex chars. The
// material is picked from the best identity the occurrence actually carries, in
// this order:
//
//  1. Top 3 normalized stack frames, prefixed by the error type — the real
//     crash case. Normalization keeps only what names the code (function +
//     app-relative file) and strips everything that says WHERE that code was
//     served from or WHICH build of it ran — see normalizeFrames — so the same
//     bug yields the same fingerprint across restarts, rebuilds, namespaces,
//     worktrees and a product rename.
//  2. No parsable frames, but a caller-declared `errorType` — several callers
//     pass exactly that ON PURPOSE, so a family of varying messages collapses
//     onto one row (`PaneRestoreCorrupt`, `JobDeadline`,
//     `LiveStateWedge:<discriminator>`, `PluginLoadError <path>`,
//     `EndpointError <status> <route>`). That is a declared identity: honour it.
//  3. Neither — a browser `window.onerror` with no `Error` object, or a server
//     call site passing `stack: null` and no type. The message is then the ONLY
//     identity the report has, so it becomes the identity. Before this branch
//     existed every such report hashed the constant `Error|` and upserted onto
//     one row, which on main swallowed 499 unrelated occurrences over four
//     months — the wrong source, the wrong task and whichever message arrived
//     last.
//
// Branch 2 and 3 inputs are pinned in crash-kind.test.ts. Branch 1's input
// changed once, on 2026-11-02, when the location noise below was stripped
// (research/2026-11-02-reports-host-independent-crash-fingerprint.md): framed
// rows recorded before then keep their old fingerprint and age out under
// retention; a recurrence lands on a new, now-stable row.
export async function crashFingerprint(
  data: CrashPayload,
  ctx: ReportFingerprintContext,
): Promise<string> {
  const frames = normalizeFrames(data.stack ?? "");
  const input =
    frames.length > 0
      ? `${data.errorType ?? "Error"}|${frames.slice(0, 3).join("|")}`
      : data.errorType
        ? `${data.errorType}|`
        : `Error|msg:${normalizeMessage(ctx.message)}`;
  return sha256Hex(input).then((h) => h.slice(0, 16));
}

// A V8 frame: `at fn (url:12:3)`. Safari and Firefox instead spell one
// `fn@https://host/file.js:12:3` — no "at", no spaces — and reading only the V8
// form left those stacks with zero frames, dropping a perfectly good crash into
// the message branch. Requiring the WHOLE line to be `<name>@<location>` keeps a
// stack's prose header line out, even when the message itself contains an "@".
const NON_V8_FRAME = /^[^@\s]*@\S+$/;

// A frame's identity is the function and the app-relative file it ran in. Its
// location also carries what varies between occurrences of ONE bug, each
// stripped below:
//  - line:col, cache-busters (`?v=`, `?t=`, `?import`) — every edit/dev reload;
//  - the origin (`http://<namespace>.localhost:9000`, `file://`) — the
//    namespace serving the page differs per worktree, main answers on its
//    alias, and a product rename moved every host;
//  - a content hash in a path (`/artifacts/network.live.web.<16 hex>/`, a
//    worker chunk, a package asset) — every rebuild of that artifact;
//  - an absolute checkout prefix (`/Users/…/repo/.claude/worktrees/<id>/`, or
//    vite's `/@fs/…`) — the checkout a server or dev frame ran from. The path
//    is cut at its first `/plugins/` or `/node_modules/`, the repo's own roots.
//
// Exported for the test, which pins the normalized form.
export function normalizeFrames(stack: string): string[] {
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") || NON_V8_FRAME.test(l))
    .map((l) =>
      l
        .replace(/:\d+:\d+\)?$/, "")
        .replace(/\?(?:v|t|import)=[a-z0-9]+/gi, "")
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^/\s()]*/gi, "")
        .replace(/(?:[.-][0-9a-f]{16}(?=[/.])|(?<=\/)[0-9a-f]{16}\.)/g, "")
        .replace(/\/node_modules\/\.vite\/deps\//, "/NM/")
        .replace(/\/@fs\//, "/")
        .replace(
          /(?<=[\s(@])[^\s()@]*?(?=\/(?:plugins|node_modules|NM)\/)/,
          "",
        ),
    );
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
