import { PROTOTYPE_VERSION_KINDS, type PrototypeVersionKind } from "../../core";

// A version's commit message — the one place its format is written AND read.
//
//   <subject: one line, ≤ 72 chars>
//
//   <body: the request and the agent's summary, for a turn>
//
//   Prototype-Kind: turn
//   Prototype-Conversation: <conversationId>
//   Prototype-Message: <messageId>
//
// The metadata rides as trailers so `git log` — what an agent reads — shows it
// in place, and so the history needs no side table. Parsed here rather than by
// `git log --format=%(trailers)` so the writer and the reader are one module
// that `message.test.ts` pins as inverses.

/** What one commit message says about its version. */
export interface VersionMessage {
  subject: string;
  /** `""` when there is none (every kind but `turn`, usually). */
  body: string;
  kind: PrototypeVersionKind;
  conversationId: string | null;
  messageId: string | null;
}

const TRAILER = {
  kind: "Prototype-Kind",
  conversation: "Prototype-Conversation",
  message: "Prototype-Message",
} as const;

/** `git log`'s own convention, and what fits a one-line list row. */
const SUBJECT_MAX = 72;

/**
 * Collapse free text (the first line of a user's request) into a subject line:
 * its first non-blank line, whitespace squeezed, cut to {@link SUBJECT_MAX}
 * with an ellipsis. `fallback` when nothing is left — a request made only of an
 * image still records a version, it just has nothing to be called.
 */
export function toSubjectLine(text: string, fallback: string): string {
  const line =
    stripControl(text)
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l !== "") ?? "";
  if (line === "") return fallback;
  return line.length <= SUBJECT_MAX
    ? line
    : `${line.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
}

/**
 * The message a checkpoint records: its subject's first line (≤ 72), or the
 * kind's own when it has none; its body with control characters stripped. Every
 * history provider records a checkpoint through this, so a git version and a
 * snapshot one read the same.
 */
export function checkpointMessage(input: {
  kind: "turn" | "manual";
  subject: string;
  body?: string;
  conversationId?: string;
  messageId?: string;
}): VersionMessage {
  return {
    subject: toSubjectLine(
      input.subject,
      input.kind === "turn" ? "Agent turn" : "Manual checkpoint",
    ),
    body: stripControl(input.body ?? "").trim(),
    kind: input.kind,
    conversationId: input.conversationId ?? null,
    messageId: input.messageId ?? null,
  };
}

/** Render a version's commit message. The inverse of {@link parseVersionMessage}. */
export function formatVersionMessage(message: VersionMessage): string {
  const subject = toSubjectLine(message.subject, "");
  if (subject === "") throw new Error("a version's subject cannot be empty");

  const trailers = [`${TRAILER.kind}: ${message.kind}`];
  if (message.conversationId !== null) {
    trailers.push(
      `${TRAILER.conversation}: ${trailerValue(message.conversationId)}`,
    );
  }
  if (message.messageId !== null) {
    trailers.push(`${TRAILER.message}: ${trailerValue(message.messageId)}`);
  }

  const body = stripControl(message.body).trim();
  return [subject, ...(body === "" ? [] : [body]), trailers.join("\n")].join(
    "\n\n",
  );
}

/**
 * Read a commit message written by {@link formatVersionMessage}. Throws on one
 * it did not write (no `Prototype-Kind` trailer, an unknown kind): the repo is
 * the store's own, so a foreign commit means somebody wrote into it by hand,
 * and a version list that quietly skipped it would renumber every later one.
 */
export function parseVersionMessage(raw: string): VersionMessage {
  const paragraphs = raw
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/);
  const subject = paragraphs[0] ?? "";
  const trailerBlock = paragraphs.length > 1 ? paragraphs.at(-1)! : "";
  const trailers = parseTrailers(trailerBlock);
  if (trailers === null) {
    throw new Error(
      `not a prototype version commit (no trailer block): ${JSON.stringify(subject)}`,
    );
  }

  const kind = trailers.get(TRAILER.kind);
  if (!isVersionKind(kind)) {
    throw new Error(
      `not a prototype version commit (${TRAILER.kind}: ${String(kind)}): ${JSON.stringify(subject)}`,
    );
  }
  return {
    subject,
    body: paragraphs.slice(1, -1).join("\n\n"),
    kind,
    conversationId: trailers.get(TRAILER.conversation) ?? null,
    messageId: trailers.get(TRAILER.message) ?? null,
  };
}

/** Every line `Prototype-<Key>: <value>`, or `null` when the block is not trailers. */
function parseTrailers(block: string): Map<string, string> | null {
  const trailers = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^(Prototype-[A-Za-z]+): (.*)$/.exec(line);
    if (!match) return null;
    trailers.set(match[1]!, match[2]!);
  }
  return trailers.size === 0 ? null : trailers;
}

function isVersionKind(
  value: string | undefined,
): value is PrototypeVersionKind {
  return (PROTOTYPE_VERSION_KINDS as readonly string[]).includes(value ?? "");
}

/** A trailer value is one line; a newline in an id is a caller bug, not text. */
function trailerValue(value: string): string {
  if (value === "" || /\s/.test(value) || stripControl(value) !== value) {
    throw new Error(
      `a version trailer value must be one non-empty token, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Drop control characters other than newline and tab. `git log` output is split
 * on the ASCII separators (`\x1e`, `\x1f`), so no message may carry them.
 */
function stripControl(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
