/**
 * A commit subject read as a Conventional Commit header,
 * `type(scope, scope)!: description`.
 *
 * Total: a subject that is not one (a merge, a revert's quoted subject, a hand
 * commit) reads as `type: null` with the whole subject as its description, so
 * a reader always has something to show.
 */
export interface ConventionalSubject {
  /** `feat`, `fix`, `chore` … lowercased; null when the subject has no type prefix. */
  type: string | null;
  /** The parenthesised scopes, split on commas and trimmed; empty when none. */
  scopes: string[];
  /** The `!` breaking-change marker. */
  breaking: boolean;
  /** The subject after `type(scopes)!: ` (the whole subject when there is no prefix). */
  description: string;
}

// A type is a word (letters, digits, `-`); scopes anything but parentheses.
const HEADER_RE = /^([A-Za-z][\w-]*)(?:\(([^()]*)\))?(!)?:\s+(\S.*)$/s;

export function parseConventionalSubject(subject: string): ConventionalSubject {
  const m = HEADER_RE.exec(subject);
  if (!m) {
    return { type: null, scopes: [], breaking: false, description: subject };
  }
  const [, type, scopeList, bang, description] = m;
  return {
    type: type!.toLowerCase(),
    scopes:
      scopeList === undefined
        ? []
        : scopeList
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
    breaking: bang === "!",
    description: description!,
  };
}
