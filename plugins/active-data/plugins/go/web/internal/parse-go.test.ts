import { describe, expect, test } from "bun:test";
import { isBlockForm } from "@plugins/active-data/core";
import { GO_PICK_RE, goDraft, goWire, parseGo, parseGoItem } from "./parse-go";

describe("parseGo", () => {
  test("plain prose has no items", () => {
    expect(parseGo("Implement it")).toEqual({
      lead: "Implement it",
      items: [],
      tail: "",
    });
  });

  test("splits lead, items and tail", () => {
    const body = parseGo(
      "File tasks for:\n- [ ] A\n- [x] B\n* [X] C\n\nThen push.",
    );
    expect(body).toEqual({
      lead: "File tasks for:",
      items: [
        { text: "A", checked: false },
        { text: "B", checked: true },
        { text: "C", checked: true },
      ],
      tail: "Then push.",
    });
  });

  test("a plain list item is prose, not a choice", () => {
    expect(parseGo("- A\n- [ ] B").items).toEqual([
      { text: "B", checked: false },
    ]);
  });
});

describe("goWire", () => {
  test("one line stays one line", () => {
    expect(goWire("Implement it", [])).toBe("<go>Implement it</go>");
  });

  test("a checklist sends only its picked lines — no lead, no declined items", () => {
    const content =
      "I can also file tasks for:\n\n- [x] The bug xxx\n- [ ] The bug yyy";
    expect(goWire(content, [true, false])).toBe(
      "<go>\n- [x] The bug xxx\n</go>",
    );
  });

  test("multi-line prose keeps its lines", () => {
    expect(goWire("Do A.\nThen B.", [])).toBe("<go>\nDo A.\nThen B.\n</go>");
  });
});

describe("goDraft", () => {
  test("a block closes on its last line, the caret goes below it", () => {
    expect(goDraft("<go>\n- [x] A\n- [x] B\n</go>")).toBe(
      "<go>\n- [x] A\n- [x] B</go>\n",
    );
  });

  test("one line is followed by a space", () => {
    expect(goDraft("<go>Implement it</go>")).toBe("<go>Implement it</go> ");
  });
});

// Every surface decides card vs chip with active-data's isBlockForm over the
// text between the tags; these pin what the draft and the wire hand it.
describe("block form of what Go sends", () => {
  const body = (sent: string) => /^<go>([\s\S]*)<\/go>\s*$/.exec(sent)![1]!;

  test("one inline line is a chip", () => {
    expect(isBlockForm(body(goDraft(goWire("Implement it", []))))).toBe(false);
  });

  test("a single picked item sent from the draft is a card", () => {
    const sent = goDraft(goWire("- [x] A\n- [ ] B", [true, false]));
    expect(sent).toBe("<go>\n- [x] A</go>\n");
    expect(isBlockForm(body(sent))).toBe(true);
  });

  test("a single picked item sent directly is a card", () => {
    expect(isBlockForm(body(goWire("- [ ] A", [true])))).toBe(true);
  });
});

describe("parseGoItem", () => {
  test("reads a checklist line, rejects prose", () => {
    expect(parseGoItem("- [x] A")).toEqual({ text: "A", checked: true });
    expect(parseGoItem("- A")).toBeNull();
  });

  test("the draft's pick token matches exactly the picked items", () => {
    for (const line of [
      "- [x] A",
      "* [X] B",
      "+ [x] C",
      "- [ ] D",
      "- A",
      "-[x] E",
    ]) {
      GO_PICK_RE.lastIndex = 0;
      expect(GO_PICK_RE.test(line)).toBe(parseGoItem(line)?.checked === true);
    }
  });
});
