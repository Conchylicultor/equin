import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  claimsResizeLoopError,
  installResizeLoopTrace,
  resizeLoopReportSink,
  type ResizeLoopObservation,
  type ResizeLoopReport,
} from "./internal/resize-loop-trace";

export default {
  description:
    "Names the observers behind a 'ResizeObserver loop completed with undelivered notifications' error, which the browser raises with no stack: installResizeLoopTrace() (imported first by main.tsx) wraps the page's ResizeObserver to remember the callbacks of the current pass and where each observer was created; when the loop error fires it emits, on resizeLoopReportSink, that pass and the notifications held back to the next frame (the elements whose resize could not be delivered). claimsResizeLoopError(e) tells the window-error reporter the tracer reports this one.",
  contributions: [],
} satisfies PluginDefinition;
