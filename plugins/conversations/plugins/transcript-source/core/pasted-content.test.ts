import { describe, expect, test } from "bun:test";
import { unwrapPastedContent } from "./pasted-content";

/** How the CLI writes a block, padding included. */
const block = (id: string, body: string) =>
  `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`;

describe("unwrapPastedContent", () => {
  test("a whole turn inside one block is that turn", () => {
    // conv att-1789860876-o4zv, the row that rendered as "Not confirmed".
    const raw = `\n\n${block("e112", "Answering your questions:\n\n- Scope: Delete the whole apparatus (Recommended)")}`;
    expect(unwrapPastedContent(raw)).toBe(
      "Answering your questions:\n\n- Scope: Delete the whole apparatus (Recommended)",
    );
  });

  test("typed text around a block keeps its own words", () => {
    const raw = `Look at this:\n\n${block("a1b2", "the pasted bit")}and then fix it`;
    expect(unwrapPastedContent(raw)).toBe(
      "Look at this:the pasted bitand then fix it",
    );
  });

  test("several blocks in one turn all unwrap", () => {
    const raw = `${block("00ff", "first")}${block("beef", "second")}`;
    expect(unwrapPastedContent(raw)).toBe("firstsecond");
  });

  test("a body spanning many lines survives intact", () => {
    const body = "line one\nline two\n\nline four";
    expect(unwrapPastedContent(block("c0de", body))).toBe(body);
  });

  test("text with no block is returned unchanged", () => {
    for (const text of [
      "just a normal message",
      "",
      "mentions <pasted_content> without an id",
      // Ids are exactly four lowercase-hex characters.
      '<pasted_content id="XYZW">\nbody\n</pasted_content id="XYZW">\n',
      '<pasted_content id="e11">\nbody\n</pasted_content id="e11">\n',
    ]) {
      expect(unwrapPastedContent(text)).toBe(text);
    }
  });

  test("an unterminated block is left alone rather than swallowing the turn", () => {
    const raw = '<pasted_content id="e112">\nbody that never closes';
    expect(unwrapPastedContent(raw)).toBe(raw);
  });

  test("a closing tag whose id differs does not close the block", () => {
    const raw =
      '<pasted_content id="e112">\nbody\n</pasted_content id="f113">\n';
    expect(unwrapPastedContent(raw)).toBe(raw);
  });

  test("a false opening before a real block keeps its text", () => {
    const raw = `see <pasted_content id="zz"> above\n\n${block("e112", "real")}`;
    // The newlines the CLI padded the block with are its own, so the typed
    // run ends where the pasted one begins — the draft the person had.
    expect(unwrapPastedContent(raw)).toBe(
      'see <pasted_content id="zz"> abovereal',
    );
  });

  test("is idempotent — unwrapping twice changes nothing further", () => {
    const raw = `\n\n${block("e112", "some body")}`;
    const once = unwrapPastedContent(raw);
    expect(unwrapPastedContent(once)).toBe(once);
  });
});
