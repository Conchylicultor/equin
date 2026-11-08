import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export type { TaskMarkListener, TaskMarkText } from "./internal/task-marks";
export { onTaskMark, runMarked } from "./internal/task-marks";

export default {
  description:
    "Say what the main thread is starting, for whoever watches it from another thread: runMarked(source, describe, fn) wraps a task's entry point — the listener hears it begin before fn runs and end one microtask after (describe runs only while a listener is installed); onTaskMark installs the one listener — main-thread-stall posts both to its out-of-thread watchdog, so a tab that freezes inside the task has already said which: the mark left open.",
  contributions: [],
} satisfies PluginDefinition;
