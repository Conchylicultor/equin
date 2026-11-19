import { z } from "zod";

// Whose code threw a window-level browser error, judged from its stack — so a
// report raised by code a browser extension put into the page reads as such
// instead of as our bug.
//
// An extension's page-world script is attributed to the page itself: Firefox
// gives its frames the document's own URL (Dark Reader's stylesheet proxy,
// `overrideProperty/<@https://equin.ai/demo:51:24`, 2026-11-19), WebKit does
// the same for any injected `<script>`. So "on our origin" proves nothing. What
// does: every script the page loads from a file has its own URL, and the only
// code the page runs AT the document URL is the inline `<script>`s the server
// wrote into it — which stay in the DOM, where their text can be read. A frame
// at the document URL whose function is named in none of them is not ours.
//
//   - `page`: a frame is in code this page serves (a script file on the page's
//     origin, or a function one of its inline scripts names) — the default
//     reading of every crash;
//   - `foreign`: every frame is provably outside it (another origin, an
//     extension's scheme, or the document at a function no inline script of
//     the page names) — a browser extension, most likely; not our code;
//   - `unknown`: neither proven (no frames, an anonymous frame at the
//     document URL, an eval / injected-element frame, an unreadable line).
//
// Never a guess in the muting direction: anything undecidable is `unknown`,
// and one frame of ours makes the whole stack `page`.
export const CodeOriginSchema = z.enum(["page", "foreign", "unknown"]);
export type CodeOrigin = z.infer<typeof CodeOriginSchema>;

interface PageCode {
  /** The page's URL (`location.href`); its query and hash are ignored. */
  documentUrl: string;
  /** The text of every inline `<script>` the document holds. */
  inlineScripts: readonly string[];
}

// The schemes extension code runs from.
const EXTENSION_SCHEME =
  /^(?:moz-extension|chrome-extension|safari-extension|safari-web-extension|webkit-masked-url):/i;

// `at name (location)` / `at location` (V8), `name@location` (Firefox, WebKit).
const V8_FRAME = /^at (?:(.*?) \()?(.+?)\)?$/;
const AT_FRAME = /^([^@\s]*)@(.+)$/;
// A location's trailing `:line:col` (or `:line`).
const POSITION = /(?::\d+){1,2}$/;
// A native frame: no code of anyone's to judge.
const NATIVE = /^(?:<anonymous>|native|\[native code\])$/;

type Frame =
  | { kind: "native" }
  | { kind: "located"; name: string; url: string }
  | { kind: "unreadable" };

function parseFrame(line: string): Frame | null {
  const v8 = V8_FRAME.exec(line);
  const at = v8 ? null : AT_FRAME.exec(line);
  if (!v8 && !at) return null; // a header / message line, not a frame
  const name = (v8 ? v8[1] : at![1]) ?? "";
  const location = (v8 ? v8[2] : at![2])!;
  if (NATIVE.test(location)) return { kind: "native" };
  // Firefox's `url line 11 > injectedScript`, `… > eval`; V8's `eval at …`.
  if (/\s/.test(location)) return { kind: "unreadable" };
  return { kind: "located", name, url: location.replace(POSITION, "") };
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

// The identifiers a frame's function name is spelled with
// (`Foo.bar [as baz]`, `overrideProperty/<`, `async*cleanUp`).
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

function namedInline(name: string, inline: readonly string[]): boolean {
  const ids = name.match(IDENTIFIER) ?? [];
  return ids.some((id) => {
    const word = new RegExp(`(?<![\\w$])${id.replace(/\$/g, "\\$")}(?![\\w$])`);
    return inline.some((text) => word.test(text));
  });
}

/** Whose code the frames of `stack` ran in — see the header comment. */
export function stackCodeOrigin(
  stack: string | null | undefined,
  page: PageCode,
): CodeOrigin {
  if (!stack) return "unknown";
  const doc = parseUrl(page.documentUrl);
  if (doc === null) return "unknown";
  let foreign = 0;
  let unknown = 0;
  for (const raw of stack.split("\n")) {
    const frame = parseFrame(raw.trim());
    if (frame === null || frame.kind === "native") continue;
    if (frame.kind === "unreadable") {
      unknown++;
      continue;
    }
    if (EXTENSION_SCHEME.test(frame.url)) {
      foreign++;
      continue;
    }
    const url = parseUrl(frame.url);
    if (url === null || !/^https?:$/.test(url.protocol)) {
      unknown++;
      continue;
    }
    if (url.origin !== doc.origin) {
      foreign++;
      continue;
    }
    // A script file of the page's own origin: ours.
    if (url.pathname !== doc.pathname) return "page";
    // At the document itself: ours only if one of its inline scripts names it.
    if (frame.name === "") unknown++;
    else if (namedInline(frame.name, page.inlineScripts)) return "page";
    else foreign++;
  }
  return unknown === 0 && foreign > 0 ? "foreign" : "unknown";
}
