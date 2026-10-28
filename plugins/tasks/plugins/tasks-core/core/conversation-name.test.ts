import { describe, expect, it } from "bun:test";
import { conversationName } from "./conversation-name";

describe("conversationName", () => {
  it("is the conversation's own title", () => {
    expect(conversationName({ title: " Fix login ", taskTitle: "Task" })).toBe(
      "Fix login",
    );
  });
  it("falls back to the task's title, then Untitled", () => {
    expect(conversationName({ title: null, taskTitle: "Task" })).toBe("Task");
    expect(conversationName({ title: "  ", taskTitle: "" })).toBe("Untitled");
  });
});
