import { useLive } from "@plugins/network/plugins/live/web";
import { subjectTask, type TaskSubject } from "../../core";

/** The live task about `subject` (see `subjectTask`). */
export function useSubjectTask(subject: TaskSubject) {
  return useLive(subjectTask, subject);
}
