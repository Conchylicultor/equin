// Its own module so the format thread can re-create it without evaluating
// `./prettier` on the calling thread.

/**
 * Prettier could not parse the bytes it was given. Its own class so the one
 * caller that can legitimately produce unparseable bytes — a partial hunk
 * selection in `./line-scope` — can tell it from every other failure; the format
 * thread re-creates it from its reply.
 */
export class FormatSyntaxError extends Error {
  override readonly name = "FormatSyntaxError";
}
