/**
 * A message the installer shows a person when something stops it, asks for a
 * permission, or leaves something out — the one shape every such message is
 * built from, so each of the five rules (CLAUDE.md) is a field to fill rather
 * than a habit to remember:
 *
 * 1. No internal names — checked on every user-facing field (`noticeProblems`).
 * 2. What equin was doing, and what it gives the user — `doing`.
 * 3. Why it was blocked, in the user's terms — `blocked`.
 * 4. What the user can do now, and what a skip costs — `now`, `ifSkipped`.
 * 5. Raw lines (error output, ids, paths) — `evidence`, rendered apart.
 */
export interface InstallerNotice {
  /** One line: what happened. "macOS blocked equin from adding its apps". */
  readonly title: string;
  /** What equin was trying to do, and why that helps the user. */
  readonly doing: string;
  /** Why it was blocked, in the user's terms. */
  readonly blocked: string;
  /** What the user can do now — each one a step. */
  readonly now: readonly string[];
  /**
   * What happens if they skip it or say no: optional (what still works, how
   * to add it later), or needed (why equin cannot go on without it).
   */
  readonly ifSkipped:
    | {
        readonly optional: true;
        readonly stillWorks: string;
        readonly addLater: string;
      }
    | { readonly optional: false; readonly because: string };
  /** Raw lines — error output, permission ids, paths. Never in the message itself. */
  readonly evidence: readonly string[];
}

/**
 * Names a user does not know: equin's own parts and the OS machinery under
 * them. A message says what the user gets instead ("an icon in your menu
 * bar", "app shortcuts in your Applications folder").
 */
export const INTERNAL_TERMS: readonly string[] = [
  "gateway",
  "helper",
  "menu-bar helper",
  "io-health",
  "daemon",
  "backend",
  "worktree",
  "crate",
  "cargo",
  "TCC",
  "sandbox",
  "build slot",
  "grant",
  "launchd",
  "launchctl",
  "LaunchAgent",
  "plist",
  "systemd",
  "PID",
  "bundle",
  "rcodesign",
  "EPERM",
  "Postgres",
  "PgBouncer",
];

const TERM_RES = INTERNAL_TERMS.map(
  (term) =>
    [
      term,
      new RegExp(`(^|[^A-Za-z0-9-])${escape(term)}($|[^A-Za-z0-9-])`, "i"),
    ] as const,
);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What in `text` breaks rules 1 and 5: internal names, paths, reverse-DNS
 * labels and multi-line output. A `backtick span` (a command the user types)
 * and a URL are the user's to copy, so they are not read.
 */
export function plainTextProblems(text: string): string[] {
  const prose = text.replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ");
  const problems: string[] = [];
  for (const [term, re] of TERM_RES) {
    if (re.test(prose)) problems.push(`internal name "${term}"`);
  }
  const path = /(^|\s)(~|\.{0,2})\/\S+/.exec(prose);
  if (path) problems.push(`path "${path[0].trim()}"`);
  const label = /\b[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]+\b/.exec(
    prose,
  );
  if (label) problems.push(`label "${label[0]}"`);
  if (prose.includes("\n"))
    problems.push("a line break (raw output goes in evidence)");
  return problems;
}

/** Every rule a notice's user-facing fields break, named; empty when it keeps them all. */
export function noticeProblems(notice: InstallerNotice): string[] {
  const fields: [string, string][] = [
    ["title", notice.title],
    ["doing", notice.doing],
    ["blocked", notice.blocked],
    ...notice.now.map((n, i): [string, string] => [`now[${i}]`, n]),
    ...(notice.ifSkipped.optional
      ? ([
          ["ifSkipped.stillWorks", notice.ifSkipped.stillWorks],
          ["ifSkipped.addLater", notice.ifSkipped.addLater],
        ] as [string, string][])
      : ([["ifSkipped.because", notice.ifSkipped.because]] as [
          string,
          string,
        ][])),
  ];
  const problems: string[] = [];
  for (const [field, text] of fields) {
    if (text.trim() === "") problems.push(`${field}: empty`);
    for (const p of plainTextProblems(text)) problems.push(`${field}: ${p}`);
  }
  if (notice.now.length === 0) problems.push("now: no step for the user");
  return problems;
}

/**
 * Build a notice, refusing one that breaks a rule — loudly, naming each
 * break, so a message with "gateway" in it fails its own test (and the
 * command that would print it) rather than reaching a user.
 */
export function defineNotice(notice: InstallerNotice): InstallerNotice {
  const problems = noticeProblems(notice);
  if (problems.length > 0) {
    throw new Error(
      `installer notice "${notice.title}" breaks the installer message rules (infra/launcher/installer-notice):\n  - ${problems.join("\n  - ")}`,
    );
  }
  return notice;
}

/** "a, b and c": names in a sentence. */
export function joinNames(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * A notice thrown: what a check that stops equin (deep inside a call, e.g. the
 * launcher's host preconditions) raises so the command running it prints the
 * notice ITSELF — `console.error(err.message)` and exit 1 — never Bun's
 * uncaught-error dump of stack frames around it (rule 5).
 */
export class InstallerNoticeError extends Error {
  constructor(readonly notice: InstallerNotice) {
    super(renderNotice(notice));
    this.name = "InstallerNoticeError";
  }
}

/**
 * The notice as terminal text: the message, then the evidence under its own
 * "Details" heading, apart from it.
 */
export function renderNotice(notice: InstallerNotice): string {
  const lines = [
    `! ${notice.title}`,
    `  ${notice.doing}`,
    `  ${notice.blocked}`,
    "",
    "  What you can do:",
    ...notice.now.map((step) => `    - ${step}`),
    "",
    notice.ifSkipped.optional
      ? `  It's optional: ${notice.ifSkipped.stillWorks} ${notice.ifSkipped.addLater}`
      : `  equin needs it: ${notice.ifSkipped.because}`,
  ];
  if (notice.evidence.length > 0) {
    lines.push("", "  Details (for a bug report):");
    for (const line of notice.evidence.flatMap((e) => e.split("\n"))) {
      lines.push(`    ${line}`);
    }
  }
  return lines.join("\n");
}
