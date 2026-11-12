/**
 * What one runner's JUnit report says about a test run, reduced to the two
 * facts a comparison needs: which test cases failed, and which test files the
 * report mentions at all.
 *
 * Both runners write JUnit (`bun test --reporter=junit`, vitest's `junit`
 * reporter). Their shapes differ in the details — bun nests a `<testsuite>` per
 * `describe` and puts `file` on every element, vitest puts the file in the
 * top-level suite's `name` and the describe path in the case `name` — so a
 * case is identified by its file plus every enclosing suite name below the file
 * plus its own name, which is stable across runs of the same code under either.
 *
 * A file that throws while loading has no `<testsuite>` in bun's report at
 * all. The report cannot name it; the caller, which knows which files it asked
 * to run, compares against `files`.
 */
export interface JunitSummary {
  /** `<file> > <suite> > … > <case>` for every case with a failure or error. */
  failures: string[];
  /** Every test file the report mentions (a suite's `file`, else its `name`). */
  files: string[];
  /** Per file the report mentions: its case count, failing cases and time. */
  byFile: Record<string, JunitFileStats>;
  /** Every failing case, with what its `<failure>` / `<error>` says. */
  failureDetails: JunitFailure[];
}

export interface JunitFileStats {
  /** `<testcase>` elements under the file (skipped ones included). */
  cases: number;
  /** Cases with a `<failure>` or `<error>`. */
  failed: number;
  /** The file suite's `time` (seconds → ms), else the sum of its cases'. */
  timeMs: number;
}

export interface JunitFailure {
  file: string;
  /** `<suite> > … > <case>`, below the file. */
  caseId: string;
  /** The first failure's `message` attribute, else its first text line. */
  message: string;
  /** The failure elements' text (a stack, a diff), decoded. */
  detail: string;
}

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x"))
      return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(Number(ref.slice(1)));
    return ENTITIES[ref] ?? whole;
  });
}

function attr(tag: string, name: string): string | undefined {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? undefined : decode(value);
}

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function secondsToMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
}

export function parseJunit(xml: string): JunitSummary {
  const failures: string[] = [];
  const files = new Set<string>();
  const byFile: Record<string, JunitFileStats> = {};
  const fileTime = new Map<string, number>();
  const caseTime = new Map<string, number>();
  const failureDetails: JunitFailure[] = [];
  // Each open suite: its name, and whether it is the file-level one.
  const suites: Array<{ name: string; file: string | undefined }> = [];
  let openCase: {
    file: string;
    caseId: string;
    id: string;
    failed: boolean;
    message: string | null;
    detail: string[];
  } | null = null;
  // The text start of an open <failure> / <error>, to read its body at the close.
  let openFailureAt: number | null = null;

  const statsOf = (file: string): JunitFileStats =>
    (byFile[file] ??= { cases: 0, failed: 0, timeMs: 0 });

  const tags = /<(\/?)(testsuite|testcase|failure|error)\b([^>]*?)(\/?)>/g;
  for (const match of xml.matchAll(tags)) {
    const [whole, closing, kind, rest, selfClosing] = match;
    const tag = ` ${rest}`;
    if (kind === "testsuite") {
      if (closing) {
        suites.pop();
        continue;
      }
      const name = attr(tag, "name") ?? "";
      const file =
        attr(tag, "file") ?? (suites.length === 0 ? name : undefined);
      if (suites.length === 0 && file !== undefined) {
        files.add(file);
        statsOf(file);
        const ms = secondsToMs(attr(tag, "time"));
        if (ms !== null) fileTime.set(file, (fileTime.get(file) ?? 0) + ms);
      }
      if (!selfClosing) suites.push({ name, file });
      continue;
    }
    if (kind === "testcase") {
      if (closing) {
        if (openCase?.failed) {
          failures.push(openCase.id);
          statsOf(openCase.file).failed++;
          const detail = openCase.detail.join("\n").trim();
          failureDetails.push({
            file: openCase.file,
            caseId: openCase.caseId,
            message:
              openCase.message ??
              detail
                .split("\n")
                .find((l) => l.trim() !== "")
                ?.trim() ??
              "",
            detail,
          });
        }
        openCase = null;
        continue;
      }
      const top = suites[0];
      const file = attr(tag, "file") ?? top?.file ?? top?.name ?? "";
      const path = suites.slice(1).map((s) => s.name);
      const caseId = [...path, attr(tag, "name") ?? ""].join(" > ");
      const id = [file, caseId].join(" > ");
      statsOf(file).cases++;
      const ms = secondsToMs(attr(tag, "time"));
      if (ms !== null) caseTime.set(file, (caseTime.get(file) ?? 0) + ms);
      if (selfClosing) continue;
      openCase = { file, caseId, id, failed: false, message: null, detail: [] };
      continue;
    }
    // <failure> / <error>, inside a case.
    if (openCase === null) continue;
    if (closing) {
      if (openFailureAt !== null) {
        const text = decode(stripCdata(xml.slice(openFailureAt, match.index)));
        if (text.trim() !== "") openCase.detail.push(text.trim());
      }
      openFailureAt = null;
      continue;
    }
    openCase.failed = true;
    openCase.message ??= attr(tag, "message") ?? null;
    openFailureAt = selfClosing ? null : match.index + whole.length;
  }
  for (const [file, stats] of Object.entries(byFile))
    stats.timeMs = fileTime.get(file) ?? caseTime.get(file) ?? 0;
  return { failures, files: [...files], byFile, failureDetails };
}
