import { useLive } from "@plugins/network/plugins/live/web";
import { subjectTask, type TaskSubject } from "../../core";

/**
 * The live task about `subject` (see `subjectTask`). `null` skips the read —
 * pending, nothing asked — for a caller whose subject is not known yet.
 */
export function useSubjectTask(subject: TaskSubject | null) {
  return useLive(subjectTask, subject);
}
