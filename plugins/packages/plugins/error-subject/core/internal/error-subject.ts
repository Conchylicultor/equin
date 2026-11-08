// What an error is ABOUT, carried by the error itself — so every report filed
// from it tells one cause from another, whichever filer catches it.
//
// A report's crash fingerprint is its top stack frames. When the throw site is
// shared code acting for many subjects — the migration runner applying one of
// hundreds of files, the trigger installer one table of many, Postgres' own
// protocol parser raising every server error — those frames are the same for
// every subject, so every failure of that code lands on ONE row whatever its
// cause (on main: every "backend crashed during boot" migration failure since
// 2026-11-05 on report-1793851409-s559e6). The words that told them apart sat
// only in the message, which the stack branch of the fingerprint never reads.
//
// So the shared throw site names its subject (`SubjectError`), and every filer
// derives its crash fields from the error (`crashFieldsOf`) instead of copying
// `name` / `stack` by hand — `error-subject/crash-fields-of` rejects the copy.
// The subject becomes the report's `scope`, part of its identity.

/**
 * An error a SHARED throw site raises for one of the many subjects it acts
 * for: `subject` names which, in words stable across occurrences of one cause
 * (a migration's slug, a table — never a run id, a timestamp or a worktree).
 */
export class SubjectError extends Error {
  readonly subject: string;
  constructor(
    message: string,
    { subject, cause }: { subject: string; cause?: unknown },
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.subject = subject;
  }
}

// An error class code, as Node (`ENOENT`) and Postgres (SQLSTATE `42701`) spell
// one: a short token naming the KIND of failure, the same on every occurrence.
// Anything else in a `code` field (a number, prose) is not an identity.
const CLASS_CODE = /^[A-Z0-9_]{2,32}$/;

/** At most this many links of a `cause` chain are read (a cycle ends too). */
const MAX_CHAIN = 8;

/**
 * The subject of `err` in words, or null when nothing on it names one: every
 * `SubjectError` subject along its `cause` chain, outermost first, then the
 * class code (`code`) of the innermost error carrying one — so one migration
 * failing with "column already exists" (42701) and with a lock timeout (55P03)
 * are two causes, and so are two Postgres errors raised by the same parser
 * frames. Never a per-occurrence value: a subject is a stable name by contract,
 * and a code is a class.
 */
export function errorSubject(err: unknown): string | null {
  const subjects: string[] = [];
  let code: string | null = null;
  const seen = new Set<unknown>();
  let at: unknown = err;
  while (at instanceof Error && !seen.has(at) && seen.size < MAX_CHAIN) {
    seen.add(at);
    if (at instanceof SubjectError) subjects.push(at.subject);
    const c = (at as { code?: unknown }).code;
    if (typeof c === "string" && CLASS_CODE.test(c)) code = c;
    at = at.cause;
  }
  if (code !== null) subjects.push(`code ${code}`);
  return subjects.length > 0 ? subjects.join(" › ") : null;
}

/** The crash-report fields an error yields: what the crash fingerprint reads. */
// A type alias, not an interface: a report's `data` is a plain record.
export type CrashFields = {
  errorType: string;
  stack: string | null;
  scope: string | null;
};

/**
 * The crash fields of a caught `err`, for any filer (a report sink, a crash
 * listener, the outbox). `scope` is what the caller already knows the error is
 * about (a job's name, a plugin hook) followed by the error's own subject
 * (`errorSubject`). A non-Error throw has no stack of its own: none, rather
 * than the filer's.
 */
export function crashFieldsOf(
  err: unknown,
  scope: string | null = null,
): CrashFields {
  const isError = err instanceof Error;
  const parts = [scope, errorSubject(err)].filter(
    (p): p is string => p !== null && p !== "",
  );
  return {
    errorType: isError ? err.name : typeof err,
    stack: isError ? (err.stack ?? null) : null,
    scope: parts.length > 0 ? parts.join(" › ") : null,
  };
}
