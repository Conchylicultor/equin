import { describe, expect, test } from "bun:test";
import { isBlockForm } from "@plugins/active-data/core";
import { GO_PICK_RE, goDraft, goWire, parseGo, parseGoItem } from "./parse-go";

describe("parseGo", () => {
  test("plain prose has no items", () => {
    expect(parseGo("Implement it")).toEqual({
      lead: "Implement it",
      items: [],
      head: null,
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
        { text: "A", checked: false, cells: [] },
        { text: "B", checked: true, cells: [] },
        { text: "C", checked: true, cells: [] },
      ],
      head: null,
      tail: "Then push.",
    });
  });

  test("a plain list item is prose, not a choice", () => {
    expect(parseGo("- A\n- [ ] B").items).toEqual([
      { text: "B", checked: false, cells: [] },
    ]);
  });
});

describe("parseGo — pick tables", () => {
  const table = [
    "Pick which to apply:",
    "| Item | Problem | Proposed |",
    "|---|:--|---|",
    '| [x] **Themes** | "wear" | Each app \\| its theme |',
    "| [ ] Music | Too much detail | A piano app |",
    "",
    "The rest are fine.",
  ].join("\n");

  test("rows leading with a mark are the items; the header is kept", () => {
    expect(parseGo(table)).toEqual({
      lead: "Pick which to apply:",
      items: [
        {
          text: "**Themes**",
          checked: true,
          cells: ['"wear"', "Each app | its theme"],
        },
        {
          text: "Music",
          checked: false,
          cells: ["Too much detail", "A piano app"],
        },
      ],
      head: ["Item", "Problem", "Proposed"],
      tail: "The rest are fine.",
    });
  });

  test("a table with an unmarked row is prose", () => {
    const body = parseGo("| A | B |\n|---|---|\n| [x] a | b |\n| c | d |");
    expect(body.items).toEqual([]);
    expect(body.head).toBeNull();
  });

  test("a table without a header rule is prose", () => {
    expect(parseGo("| [x] a | b |\n| [ ] c | d |").items).toEqual([]);
  });

  test("one set of items per Go: a checklist after a pick table is prose", () => {
    const body = parseGo("| A |\n|---|\n| [x] a |\n- [x] b");
    expect(body.items.map((i) => i.text)).toEqual(["a"]);
    expect(body.tail).toBe("- [x] b");
  });

  test("a picked row is sent as a checklist line of its first cell", () => {
    expect(goWire(table, [true, false])).toBe("<go>\n- [x] **Themes**\n</go>");
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
    expect(parseGoItem("- [x] A")).toEqual({
      text: "A",
      checked: true,
      cells: [],
    });
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
