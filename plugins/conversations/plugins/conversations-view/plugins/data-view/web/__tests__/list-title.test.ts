import { describe, expect, it } from "vitest";
import { resolveListTitle } from "../internal/list-title";

const conv = {
  id: "c1",
  title: "Pane title from Claude Code",
  status: "working" as const,
  kind: "user" as const,
  createdAt: new Date(),
  taskTitle: "Add a conversation list title setting",
};
const fresh = {
  shortTitle: "List title setting",
  sourceTitle: conv.taskTitle,
};

describe("resolveListTitle", () => {
  it("conversation mode shows the conversation title", () => {
    expect(resolveListTitle("conversation", conv, null)).toEqual({
      label: conv.title,
      full: conv.title,
    });
  });

  it("conversation mode names an untitled conversation like every surface", () => {
    expect(
      resolveListTitle(
        "conversation",
        { ...conv, title: null, status: "starting" },
        null,
      ),
    ).toEqual({ label: "Starting…", full: "Starting…" });
  });

  it("an untitled conversation past starting is not called Starting…", () => {
    expect(
      resolveListTitle("conversation", { ...conv, title: null }, null),
    ).toEqual({ label: "Untitled", full: "Untitled" });
  });

  it("task mode shows the task title", () => {
    expect(resolveListTitle("task", conv, fresh)).toEqual({
      label: conv.taskTitle,
      full: conv.taskTitle,
    });
  });

  it("short mode shows a fresh short title, the full task title on hover", () => {
    expect(resolveListTitle("short", conv, fresh)).toEqual({
      label: "List title setting",
      full: conv.taskTitle,
    });
  });

  it("short mode never shows a stale short title", () => {
    const stale = { shortTitle: "Old name", sourceTitle: "An older title" };
    expect(resolveListTitle("short", conv, stale)).toEqual({
      label: conv.taskTitle,
      full: conv.taskTitle,
    });
  });

  it("short mode without a short title shows the task title", () => {
    expect(resolveListTitle("short", conv, null)).toEqual({
      label: conv.taskTitle,
      full: conv.taskTitle,
    });
  });

  it("throws on an unknown mode", () => {
    expect(() => resolveListTitle("bogus", conv, null)).toThrow(/bogus/);
  });
});
