/**
 * Resolve raw omnibox input into a navigation target.
 *
 * - `{ kind: "home" }` — empty input; caller should `goHome()`.
 * - `{ kind: "url", url }` — a fully-formed URL to `navigate(url)`.
 *
 * Rules (in order):
 *  - trim; empty → home.
 *  - already `^https?://`, or a `data:` / `about:` / `view-source:` URL → as-is
 *    (pages open in a real Chromium, which loads them).
 *  - host is `localhost` / `127.*` / `*.localhost` → prefix `http://`.
 *  - looks like a domain (has `.`, no whitespace) → prefix `https://`.
 *  - else → Google search (DuckDuckGo answers the engine's headless Chromium
 *    with an error page).
 */
export type NormalizedInput =
  | { kind: "home" }
  | { kind: "url"; url: string };

export function normalizeInput(raw: string): NormalizedInput {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "home" };

  if (/^(https?:\/\/|data:|about:|view-source:)/i.test(trimmed)) {
    return { kind: "url", url: trimmed };
  }

  const hasWhitespace = /\s/.test(trimmed);
  const firstSegment = trimmed.split("/")[0] ?? "";
  const isLocal =
    firstSegment === "localhost" ||
    /^127\./.test(firstSegment) ||
    /\.localhost(:\d+)?$/i.test(firstSegment);

  if (!hasWhitespace && isLocal) {
    return { kind: "url", url: `http://${trimmed}` };
  }

  if (!hasWhitespace && trimmed.includes(".")) {
    return { kind: "url", url: `https://${trimmed}` };
  }

  return {
    kind: "url",
    url: `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`,
  };
}
