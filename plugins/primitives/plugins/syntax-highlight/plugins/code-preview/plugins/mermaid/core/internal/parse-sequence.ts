import {
  SEQUENCE_BLOCK_TYPES,
  type MermaidParse,
  type SequenceBlockSection,
  type SequenceBlockType,
  type SequenceItem,
  type SequenceMessage,
  type SequenceParticipant,
} from "./model";
import { cleanLabel } from "./text";

// Longest first: `-->>` must win over `-->`, `--x` over `-x`.
const ARROWS: ReadonlyArray<{
  token: string;
  line: SequenceMessage["line"];
  head: SequenceMessage["head"];
  bidirectional: boolean;
}> = [
  { token: "<<-->>", line: "dashed", head: "arrow", bidirectional: true },
  { token: "<<->>", line: "solid", head: "arrow", bidirectional: true },
  { token: "-->>", line: "dashed", head: "arrow", bidirectional: false },
  { token: "->>", line: "solid", head: "arrow", bidirectional: false },
  { token: "--x", line: "dashed", head: "cross", bidirectional: false },
  { token: "-x", line: "solid", head: "cross", bidirectional: false },
  { token: "--)", line: "dashed", head: "async", bidirectional: false },
  { token: "-)", line: "solid", head: "async", bidirectional: false },
  { token: "-->", line: "dashed", head: "open", bidirectional: false },
  { token: "->", line: "solid", head: "open", bidirectional: false },
];

// An id may hold dashes (`question-relay`); an arrow is found by position, not by
// splitting on `-`.
const ID = String.raw`[^\s:,;+<>()]+`;
const PARTICIPANT = new RegExp(
  String.raw`^(participant|actor)\s+(${ID})(?:\s+as\s+(.+))?$`,
);
const NOTE = new RegExp(
  String.raw`^note\s+(over|left of|right of)\s+(${ID}(?:\s*,\s*${ID})?)\s*:\s?(.*)$`,
  "i",
);
const BLOCK_OPEN = new RegExp(
  String.raw`^(${SEQUENCE_BLOCK_TYPES.join("|")})\b\s*(.*)$`,
);
const BLOCK_SECTION = /^(else|and|option)\b\s*(.*)$/;
// Statements that change nothing the native renderer draws.
const IGNORED = /^(autonumber|activate|deactivate)\b/;
// Constructs Mermaid draws that are not modelled here — Mermaid draws them.
const UNMODELLED = /^(box|create|destroy|links?|properties|details)\b/;

interface OpenBlock {
  type: SequenceBlockType;
  sections: Array<{ label: string; items: SequenceItem[] }>;
}

export function parseSequence(
  lines: ReadonlyArray<{ line: number; text: string }>,
): MermaidParse {
  const participants: SequenceParticipant[] = [];
  const byId = new Map<string, SequenceParticipant>();
  const root: SequenceItem[] = [];
  const stack: OpenBlock[] = [];
  let title: string | null = null;

  const ensure = (id: string): void => {
    if (byId.has(id)) return;
    const p: SequenceParticipant = { id, label: id, kind: "participant" };
    byId.set(id, p);
    participants.push(p);
  };
  const current = (): SequenceItem[] =>
    stack.length === 0 ? root : stack.at(-1)!.sections.at(-1)!.items;
  const unread = (line: number, text: string): MermaidParse => ({
    kind: "unsupported",
    reason: `line ${line}: ${text}`,
  });

  for (const { line, text } of lines) {
    if (IGNORED.test(text)) continue;
    if (UNMODELLED.test(text)) return unread(line, text);

    const titleMatch = /^title\s*:?\s*(.*)$/.exec(text);
    if (titleMatch) {
      title = cleanLabel(titleMatch[1]!);
      continue;
    }

    const part = PARTICIPANT.exec(text);
    if (part) {
      const id = part[2]!;
      if (id.includes("@{")) return unread(line, text);
      const existing = byId.get(id);
      const label = part[3] ? cleanLabel(part[3]) : id;
      const kind = part[1] === "actor" ? "actor" : "participant";
      if (existing) {
        // A declaration after a message named it: it keeps its column.
        participants[participants.indexOf(existing)] = { id, label, kind };
        byId.set(id, participants[participants.indexOf(existing)]!);
      } else {
        const p: SequenceParticipant = { id, label, kind };
        byId.set(id, p);
        participants.push(p);
      }
      continue;
    }

    const note = NOTE.exec(text);
    if (note) {
      const over = note[2]!.split(",").map((s) => s.trim());
      over.forEach(ensure);
      const placement = note[1]!.toLowerCase();
      current().push({
        kind: "note",
        placement:
          placement === "over"
            ? "over"
            : placement === "left of"
              ? "left"
              : "right",
        over,
        text: cleanLabel(note[3]!),
      });
      continue;
    }

    const open = BLOCK_OPEN.exec(text);
    if (open) {
      stack.push({
        type: open[1] as SequenceBlockType,
        sections: [{ label: cleanLabel(open[2]!), items: [] }],
      });
      continue;
    }
    const section = BLOCK_SECTION.exec(text);
    if (section) {
      const top = stack.at(-1);
      if (!top) return unread(line, text);
      top.sections.push({ label: cleanLabel(section[2]!), items: [] });
      continue;
    }
    if (text === "end") {
      const top = stack.pop();
      if (!top) return unread(line, text);
      current().push({
        kind: "block",
        type: top.type,
        sections: top.sections satisfies SequenceBlockSection[],
      });
      continue;
    }

    const message = parseMessage(text);
    if (message) {
      ensure(message.from);
      ensure(message.to);
      current().push(message);
      continue;
    }

    return unread(line, text);
  }

  if (stack.length > 0) {
    return { kind: "unsupported", reason: `unclosed ${stack.at(-1)!.type}` };
  }
  if (participants.length === 0) {
    return { kind: "unsupported", reason: "no participants" };
  }
  return { kind: "sequence", diagram: { title, participants, items: root } };
}

function parseMessage(text: string): SequenceMessage | null {
  const colon = text.indexOf(":");
  if (colon < 0) return null;
  const head = text.slice(0, colon);
  const body = text.slice(colon + 1);
  // Leftmost arrow whose two sides are ids; at one position the longest token
  // wins (`-->>` over `-->`), and an id's own dash (`a-x`) is passed over
  // because what follows it is not an id.
  for (let i = 1; i < head.length; i++) {
    if (head[i] !== "-" && head[i] !== "<") continue;
    for (const arrow of ARROWS) {
      if (!head.startsWith(arrow.token, i)) continue;
      const from = head.slice(0, i).trim();
      // `+` / `-` after the arrow (de)activate the target — drawn as nothing here.
      const to = head
        .slice(i + arrow.token.length)
        .trim()
        .replace(/^[+-]\s*/, "");
      if (!isId(from) || !isId(to)) continue;
      return {
        kind: "message",
        from,
        to,
        text: cleanLabel(body),
        line: arrow.line,
        head: arrow.head,
        bidirectional: arrow.bidirectional,
      };
    }
  }
  return null;
}

const ID_ONLY = new RegExp(`^${ID}$`);
function isId(s: string): boolean {
  return ID_ONLY.test(s);
}
