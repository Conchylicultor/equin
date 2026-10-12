import { describe, expect, test } from "bun:test";
import {
  goDraft,
  goWire,
  isGoBlockBody,
  parseGo,
  parseGoItem,
} from "./parse-go";

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

describe("isGoBlockBody", () => {
  const body = (sent: string) => /^<go>([\s\S]*)<\/go>\s*$/.exec(sent)![1]!;

  test("one inline line is not a block", () => {
    expect(isGoBlockBody(body(goDraft(goWire("Implement it", []))))).toBe(
      false,
    );
  });

  test("a single picked item sent from the draft is still a block", () => {
    const sent = goDraft(goWire("- [x] A\n- [ ] B", [true, false]));
    expect(sent).toBe("<go>\n- [x] A</go>\n");
    expect(isGoBlockBody(body(sent))).toBe(true);
  });

  test("a single picked item sent directly is a block", () => {
    expect(isGoBlockBody(body(goWire("- [ ] A", [true])))).toBe(true);
  });
});

describe("parseGoItem", () => {
  test("reads a checklist line, rejects prose", () => {
    expect(parseGoItem("- [x] A")).toEqual({ text: "A", checked: true });
    expect(parseGoItem("- A")).toBeNull();
  });
});
