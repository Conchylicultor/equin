/**
 * The post-submit notification: a task that starts a conversation of its own
 * (a launch option says so) is announced by that conversation, server-side —
 * the form says nothing for it; every other task is "Task added" about the
 * first of them, opening it in Tasks.
 */
import { describe, expect, it } from "vitest";
import type { LaunchOptionInfo } from "@plugins/tasks/plugins/launch-options/web";
import { describeOutcome } from "../internal/submit";
import type { CardDraft } from "../components/task-draft-form";

const autoStart: LaunchOptionInfo = {
  id: "auto-start",
  def: {
    id: "auto-start",
    defaultValue: "opus",
  } as unknown as LaunchOptionInfo["def"],
  summarize: (v) => (v ? String(v) : null),
  startsConversation: (v) => v !== null,
};

const card = (text: string, model: string | null): CardDraft => ({
  localId: text,
  text,
  options: { "auto-start": model },
  linkedToPrev: true,
});

const outcome = (n: number) => ({
  ok: true,
  totalCount: n,
  taskIds: Array.from({ length: n }, (_, i) => `task-179314567${i}-abcdef`),
});

describe("describeOutcome", () => {
  it("says nothing when every task starts a conversation", () => {
    expect(
      describeOutcome(outcome(1), [card("Fix login", "opus")], [autoStart]),
    ).toBeNull();
  });

  it("one task with no conversation: Task added, about it, opening it", () => {
    const n = describeOutcome(
      outcome(1),
      [card("Fix login bug\nmore", null)],
      [autoStart],
    );
    expect(n).toMatchObject({
      title: "Task added",
      subjectId: "task-1793145670-abcdef",
      subjectName: "Fix login bug",
      category: "conversations",
      action: { kind: "open" },
    });
    expect(String(n?.action?.payload.to)).toContain("task-1793145670-abcdef");
  });

  it("a chain counts only the tasks without a conversation", () => {
    const n = describeOutcome(
      outcome(3),
      [card("A", "opus"), card("B", null), card("C", null)],
      [autoStart],
    );
    expect(n?.title).toBe("2 tasks added");
    expect(n?.subjectId).toBe("task-1793145671-abcdef");
  });
});
