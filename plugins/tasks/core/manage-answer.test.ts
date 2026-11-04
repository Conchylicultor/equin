import { describe, expect, test } from "bun:test";
import {
  formatManageAnswer,
  readManageAnswer,
  type ManageAnswer,
} from "./manage-answer";

describe("edit_task / drop_task's answer", () => {
  const answers: ManageAnswer[] = [
    { kind: "edited", taskId: "task-1", changed: ["title", "start armed"] },
    { kind: "dropped", taskId: "task-1" },
    { kind: "refused", message: "task-1 is dropped — it will not run." },
  ];

  test("every answer reads back as written", () => {
    for (const a of answers)
      expect(readManageAnswer(formatManageAnswer(a))).toEqual(a);
  });

  test("an answer in another shape stays text", () => {
    expect(readManageAnswer("Done.")).toEqual({ kind: "text", text: "Done." });
  });
});
