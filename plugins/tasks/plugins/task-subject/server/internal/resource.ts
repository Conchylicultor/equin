import { taskDroppedStatesServed } from "@plugins/tasks/plugins/tasks-core/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { subjectLinks, subjectTask } from "../../core";
import { tasksSubject } from "./tables";

// The tasks filed about each subject.
export const subjectLinksServed = serveCollection(subjectLinks, {
  from: tasksSubject,
});

// The subject's links, then whether each linked task is dropped (`follow.from`
// the links' task ids): a launch about this subject, or a drop or restore of
// one of its tasks, recomputes its readers — a link about another subject, or
// any other task's drop, reaches none. The live task is the linked task not
// dropped (a launch reuses it, so there is at most one; a tie takes the last
// by id, as stamped ids sort by when they were minted).
export const subjectTaskServed = serveValue(subjectTask, {
  source: "db",
  follows: (follow) => {
    const links = follow(subjectLinksServed, ({ kind, id }) => ({
      where: { subjectKind: kind, subjectId: id },
    }));
    return {
      links,
      tasks: follow.from({ links }, taskDroppedStatesServed, (_p, r) => ({
        ids: r.links.map((l) => l.taskId),
      })),
    };
  },
  loader: (_params, { followed }) => {
    const live = new Set(
      followed.tasks.filter((t) => t.droppedAt === null).map((t) => t.id),
    );
    return {
      taskId:
        followed.links.findLast((l) => live.has(l.taskId))?.taskId ?? null,
    };
  },
});
