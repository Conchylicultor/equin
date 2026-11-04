/**
 * The text of `edit_task` / `drop_task`'s answer, written by the tools and
 * read back by the transcript viewer, from this one place so the two cannot
 * drift. A text the reader does not recognise stays text.
 */

export type ManageAnswer =
  /** `changed`: what the edit touched, in the tool's words (`title`,
   *  `add_after`, `start armed`…). */
  | { kind: "edited"; taskId: string; changed: readonly string[] }
  | { kind: "dropped"; taskId: string }
  | { kind: "refused"; message: string };

export function formatManageAnswer(answer: ManageAnswer): string {
  switch (answer.kind) {
    case "edited":
      return `Edited ${answer.taskId} (${answer.changed.join(", ")}).`;
    case "dropped":
      return `Dropped ${answer.taskId}.`;
    case "refused":
      return `Refused: ${answer.message}`;
  }
}

export type ReadManageAnswer = ManageAnswer | { kind: "text"; text: string };

export function readManageAnswer(text: string): ReadManageAnswer {
  const refused = /^Refused: ([\s\S]*)$/.exec(text);
  if (refused) return { kind: "refused", message: refused[1]! };
  const edited = /^Edited (\S+) \((.*)\)\.$/.exec(text);
  if (edited)
    return {
      kind: "edited",
      taskId: edited[1]!,
      changed: edited[2]!.split(", "),
    };
  const dropped = /^Dropped (\S+)\.$/.exec(text);
  if (dropped) return { kind: "dropped", taskId: dropped[1]! };
  return { kind: "text", text };
}
