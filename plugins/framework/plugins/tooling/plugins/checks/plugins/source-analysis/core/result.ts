import type TS from "typescript";

// The fail-closed vocabulary every source-analysis answer is spelled in. A
// question the analysis cannot answer from syntax comes back as an
// `Unreadable` naming where and why — never as `undefined`, an empty list or a
// skipped use a caller could mistake for "nothing there".

/** Where something is: a repo-relative file and a 1-based line. */
export interface SourceSite {
  rel: string;
  line: number;
}

/** A use or declaration the analysis could not read, and why. */
export interface Unreadable {
  site: SourceSite;
  /** What made it unreadable and how to write it so it can be read. */
  reason: string;
  /** The source text of the node in question (one line, trimmed). */
  text: string;
}

/** One answer: the value read, or the reason it could not be. */
export type Readout<T> =
  { kind: "read"; value: T } | { kind: "unreadable"; unreadable: Unreadable };

/**
 * A fail-closed collection: everything read, and everything that could not be
 * — the second list is part of the answer, not a log. A caller reports each
 * `Unreadable` as a violation (a check) or refuses the whole answer
 * (`failClosed`, codegen); it never drops them.
 */
export interface Collected<T> {
  found: T[];
  unreadable: Unreadable[];
}

/** A parsed file and the repo-relative path it was read from. */
export interface ParsedFile {
  rel: string;
  sf: TS.SourceFile;
}

export function siteOf(file: ParsedFile, node: TS.Node): SourceSite {
  const { line } = file.sf.getLineAndCharacterOfPosition(
    node.getStart(file.sf),
  );
  return { rel: file.rel, line: line + 1 };
}

export function unreadableAt(
  file: ParsedFile,
  node: TS.Node,
  reason: string,
): Unreadable {
  const text = node.getText(file.sf).replace(/\s+/g, " ").trim();
  return {
    site: siteOf(file, node),
    reason,
    text: text.length > 120 ? `${text.slice(0, 117)}...` : text,
  };
}

export function read<T>(value: T): Readout<T> {
  return { kind: "read", value };
}

export function cannotRead<T>(
  file: ParsedFile,
  node: TS.Node,
  reason: string,
): Readout<T> {
  return { kind: "unreadable", unreadable: unreadableAt(file, node, reason) };
}

/** `rel:line: reason (`text`)` — how a check or a thrown error names one. */
export function formatUnreadable(u: Unreadable): string {
  return `${u.site.rel}:${u.site.line}: ${u.reason} (\`${u.text}\`)`;
}

/**
 * The found values, or a throw naming EVERY unreadable one — for a reader
 * (codegen) whose output would silently miss what it could not read. `hint`
 * says what the reader needs the code to look like.
 */
export function failClosed<T>(collected: Collected<T>, hint: string): T[] {
  if (collected.unreadable.length === 0) return collected.found;
  throw new Error(
    [...collected.unreadable.map(formatUnreadable), hint].join("\n"),
  );
}
