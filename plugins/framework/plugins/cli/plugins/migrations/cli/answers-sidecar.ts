/**
 * The `meta/` filename holding migration `<tag>`'s answers.
 *
 * **The leading underscore is load-bearing.** drizzle-kit's `prepareOutFolder`
 * runs its pg-schema snapshot validator over every `meta/*.json` whose name does
 * NOT start with `_`, and a sidecar is not a snapshot — so an unprefixed one
 * makes drizzle print "data is malformed", exit 0, and generate nothing. That
 * blocks every subsequent build in the repo, permanently, from the first
 * answered prompt onward. `_journal.json` sits in that directory unmolested for
 * exactly this reason.
 *
 * The name is derived HERE, in one function, rather than interpolated at each of
 * the four call sites (writer, reader, two cleanup paths): a prefix that only
 * three of them apply is the same outage arriving later and harder to see.
 */
export const ANSWERS_PREFIX = "_";
export const ANSWERS_SUFFIX = "_answers.json";

export function answersSidecarName(tag: string): string {
  return `${ANSWERS_PREFIX}${tag}${ANSWERS_SUFFIX}`;
}
