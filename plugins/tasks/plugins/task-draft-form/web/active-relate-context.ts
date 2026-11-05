import { useMemo } from "react";
import {
  defineSurfaceSignal,
  useFocusedSurfaceSignal,
  useSurfaceSignal,
} from "@plugins/primitives/plugins/shortcuts/web";

export interface ActiveRelateContext {
  taskId: string;
}

// The ambient relate context: which task the FOCUSED surface's conversation is
// about, so the single global Wish button (outside any surface tree) can
// default a new task to "relate to that conversation". A surface signal, so it
// is per surface (desktop windows, keep-alive tabs; several conversation panes
// of one surface clear only their own entry) and per plugin scope: while the
// focused surface is the demo's embedded app, the page's Wish reads no related
// task — the demo's task lives behind the demo's host, not the page's server.
const relateTask = defineSurfaceSignal<string>("tasks.relate-task");

/**
 * Publish, from inside a surface, the task this pane is about (`null`: none)
 * as its surface's ambient relate context, for as long as it is mounted.
 */
export function useActiveRelateTask(taskId: string | null): void {
  useSurfaceSignal(relateTask, taskId);
}

/**
 * The FOCUSED surface's ambient relate context, when that surface renders in
 * the reader's own plugin scope; otherwise `null`.
 */
export function useActiveRelateContext(): ActiveRelateContext | null {
  const taskId = useFocusedSurfaceSignal(relateTask);
  return useMemo(() => (taskId === null ? null : { taskId }), [taskId]);
}
