// Wraps a core regex source in boundary guards for inline id patterns — the one
// reading of "an id written bare in prose". Negative lookbehind for `/` excludes
// path segments and URL subdomains; the trailing guards exclude path separators
// and dotted suffixes. Every inline id pattern goes through this so boundary
// fixes apply uniformly (it moved here from `active-data/core`, so the id kinds'
// own `detectIds` and every chip read the same boundary).
//
// The dot guard is deliberately NOT a bare `(?!\.)`: a dot after an id is a
// suffix only when something word-like follows it (`proto-….html`,
// `att-….localhost:<port>`). A dot followed by anything else is the full stop of
// the sentence the id was written in — `…on the Trimmed page of proto-….` — and
// refusing that one silently switched the chip off for every id that happened
// to end its sentence, which is where ids most often land.
export function inlineBoundary(corePattern: RegExp): RegExp {
  return new RegExp(
    `(?<!\\/)${corePattern.source}(?!\\/)(?!\\.[0-9A-Za-z])\\b`,
    "g",
  );
}
