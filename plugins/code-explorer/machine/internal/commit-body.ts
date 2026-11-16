/**
 * A commit's `%b` without its trailer block, trimmed.
 *
 * Git recognises trailers only in the message's LAST paragraph, so when it
 * parsed any (`trailerCount > 0`, read by the same `git log`) that paragraph is
 * the trailer block and is dropped whole. (Git also accepts a last paragraph
 * that mixes trailers with a few other lines; those lines go with it — the
 * trailers themselves are shown from the parsed list.)
 */
export function bodyWithoutTrailers(
  rawBody: string,
  trailerCount: number,
): string {
  const body = rawBody.replace(/\r\n/g, "\n").trim();
  if (trailerCount === 0) return body;
  const lastBreak = body.search(/\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/);
  return lastBreak < 0 ? "" : body.slice(0, lastBreak).trimEnd();
}
