import { describe, expect, test } from "bun:test";
import {
  PINNED_SECTION,
  conversationSectionIdKind,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import {
  currentFiledSection,
  filedSectionOf,
  isUserSection,
  queueSectionField,
  takesFiledRows,
} from "./queue-sections";

const a = conversationSectionIdKind.mint();
const b = conversationSectionIdKind.mint();

describe("queueSectionField", () => {
  test("Pinned, the user's sections in rank order (always drawn), then the built-ins", () => {
    const field = queueSectionField([
      { id: a, name: "Review" },
      { id: b, name: "Later" },
    ]);
    expect(field.type).toBe("enum");
    expect(field.type === "enum" ? (field.options ?? []) : []).toEqual([
      { value: "pinned", label: "Pinned" },
      { value: a, label: "Review", alwaysGroup: true },
      { value: b, label: "Later", alwaysGroup: true },
      { value: "queued", label: "Queue" },
      { value: "working", label: "Working" },
      { value: "lost", label: "Lost" },
      { value: "unranked", label: "Unranked" },
      { value: "failed", label: "Failed to start" },
      { value: "disconnected", label: "Disconnected" },
      { value: "done", label: "Done" },
    ]);
  });

  test("with no user sections, only the built-ins — none drawn when empty", () => {
    const field = queueSectionField([]);
    const options = field.type === "enum" ? (field.options ?? []) : [];
    expect(options.map((o) => o.value)).toEqual([
      "pinned",
      "queued",
      "working",
      "lost",
      "unranked",
      "failed",
      "disconnected",
      "done",
    ]);
    expect(options.some((o) => o.alwaysGroup)).toBe(false);
  });
});

describe("filedSectionOf", () => {
  test("maps a drop's section to where the row is filed", () => {
    expect(filedSectionOf("queued")).toBeNull();
    expect(filedSectionOf("pinned")).toBe(PINNED_SECTION);
    expect(filedSectionOf(a)).toBe(a);
  });

  test("read-time sections take no filed rows", () => {
    for (const key of [
      "working",
      "lost",
      "unranked",
      "failed",
      "disconnected",
      "done",
      null,
    ]) {
      expect(filedSectionOf(key)).toBeUndefined();
      expect(takesFiledRows(key)).toBe(false);
    }
    expect(takesFiledRows("queued")).toBe(true);
    expect(takesFiledRows(a)).toBe(true);
  });

  test("only a csec id is a user section", () => {
    expect(isUserSection(a)).toBe(true);
    expect(isUserSection("pinned")).toBe(false);
    expect(isUserSection(null)).toBe(false);
  });
});

describe("currentFiledSection", () => {
  test("a known section, Pinned, or the Queue for none or a deleted one", () => {
    const sections = [{ id: a, name: "Review" }];
    expect(currentFiledSection(a, sections)).toBe(a);
    expect(currentFiledSection(PINNED_SECTION, sections)).toBe(PINNED_SECTION);
    expect(currentFiledSection(null, sections)).toBeNull();
    expect(currentFiledSection(b, sections)).toBeNull();
  });
});
