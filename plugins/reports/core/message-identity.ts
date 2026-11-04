// The message as an identity: two messages describing the same problem must
// normalize to the same string, or a recurring failure mints a row per
// occurrence instead of accumulating on one. Everything replaced here is a
// token that varies between occurrences of ONE problem — the job id in
// `(job 12345)`, the conversation the sweeper happened to reclaim — and nothing
// else is touched, so two genuinely different problems stay apart.
//
// Shared by every kind whose identity includes a failure's text (crash's
// message branch, queue-dead-job's cause), so one failure normalizes to the
// same identity whichever kind files it. `message-identity.test.ts` pins both
// halves of that contract; crash's literal fingerprint hashes pin its output.
//
// `maxChars` bounds the result (a runaway message must not become a runaway
// hash input). 200 — the head of a one-line message — is crash's, pinned by its
// literal hashes; a kind whose identity sits further in (a dead job quoting its
// transcript's end after a long prefix) passes a wider bound.
export function normalizeMessage(message: string, maxChars = 200): string {
  return (
    message
      .replace(/\s+/g, " ")
      .trim()
      // Order matters: each rule runs before any rule that could chew its
      // matches into pieces. A UUID is hyphenated hex, so it goes first.
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "<uuid>",
      )
      // The shape of every id the app mints (`conv-1789653369-gpuv`,
      // `att-1789665345-p1mc`, `report-…`): a word, a timestamp, an optional
      // random suffix. Matching the SHAPE rather than an allowlist of prefixes
      // means a new id family needs no edit here.
      .replace(/\b[a-z][a-z0-9]*(?:-\d{6,})(?:-[a-z0-9]+)*\b/gi, "<id>")
      // A hash / object id. The lookahead requires at least one a–f, so a plain
      // long number is left to the digit rule below and reads as `#` rather
      // than as an opaque blob.
      .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<hex>")
      .replace(/\d+/g, "#")
      .slice(0, maxChars)
  );
}
