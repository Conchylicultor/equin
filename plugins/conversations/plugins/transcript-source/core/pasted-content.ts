/**
 * Undoing Claude Code's `<pasted_content>` wrapper, so a transcript row reads
 * as the message the person actually wrote.
 *
 * The CLI files anything it classifies as a paste under tags, and writes the
 * wrapped form into the session log:
 *
 *   \n\n<pasted_content id="e112">\nAnswering your questions:\n…\n</pasted_content id="e112">\n
 *
 * Every consumer downstream wants the text inside. The conversation view would
 * otherwise show the tags to the reader; the pending-turn check looks for the
 * text it sent and would never find it, so a delivered message shows "Not
 * confirmed" with a Retry that sends it twice; and the rewind pairing compares
 * a user turn against the queue row that carried it, where the queue stores the
 * raw draft and only the turn is wrapped.
 *
 * The app no longer produces these itself — it sends turns through the Agent
 * SDK — but they arrive anyway: from every transcript written before that.
 *
 * The grammar is the CLI's own, read off its parser rather than guessed: the id
 * is exactly four lowercase-hex characters, the opening tag is followed
 * immediately by a newline, and the closing tag REPEATS the id
 * (`</pasted_content id="e112">`, which is not valid XML). Anything that does
 * not match exactly is left alone — prose that merely mentions the tag keeps
 * its text.
 */

const OPEN_PREFIX = '<pasted_content id="';
const ID_LENGTH = 4;
/** After the id: `">` then the newline that begins the body. */
const OPEN_SUFFIX = '">\n';
/** How many newlines on each side of a block the CLI inserted with it. */
const MAX_ADJACENT_NEWLINES = 2;

function isBlockId(candidate: string): boolean {
  return /^[0-9a-f]{4}$/.test(candidate);
}

/**
 * `text` with every well-formed `<pasted_content>` block replaced by its body,
 * and the newlines the CLI padded each block with removed. Text with no block
 * is returned unchanged.
 */
export function unwrapPastedContent(text: string): string {
  let out = "";
  // Start of the not-yet-emitted text, and where to resume scanning for a tag.
  let emitted = 0;
  let scan = 0;

  for (;;) {
    const open = text.indexOf(OPEN_PREFIX, scan);
    if (open === -1) break;

    const idAt = open + OPEN_PREFIX.length;
    const id = text.slice(idAt, idAt + ID_LENGTH);
    if (!isBlockId(id) || !text.startsWith(OPEN_SUFFIX, idAt + ID_LENGTH)) {
      // Not a block — resume past this false opening rather than dropping it.
      scan = idAt;
      continue;
    }

    const bodyAt = idAt + ID_LENGTH + OPEN_SUFFIX.length;
    const close = `\n</pasted_content id="${id}">`;
    const closeAt = text.indexOf(close, bodyAt - 1);
    // An unterminated block is not a block: leave the rest of the text as-is.
    if (closeAt === -1) break;

    // The blank line the CLI put between the typed text and the block belongs
    // to the block, not to the message.
    let before = open;
    for (
      let i = 0;
      i < MAX_ADJACENT_NEWLINES &&
      before > emitted &&
      text[before - 1] === "\n";
      i++
    ) {
      before--;
    }
    out += text.slice(emitted, before);
    out += text.slice(bodyAt, closeAt);

    emitted = closeAt + close.length;
    for (let i = 0; i < MAX_ADJACENT_NEWLINES && text[emitted] === "\n"; i++) {
      emitted++;
    }
    scan = emitted;
  }

  if (emitted === 0) return text;
  return out + text.slice(emitted);
}
