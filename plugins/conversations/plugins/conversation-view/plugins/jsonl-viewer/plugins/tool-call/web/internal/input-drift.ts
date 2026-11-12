import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * A finished call whose tool TOOK its input (its result is no error) though
 * the renderer's `input` schema rejects it: the renderer's schema is wrong
 * (stricter than the tool, or behind a change to it). The card still draws —
 * the generic card, with the issues — so the drift needs a report to be seen.
 * A call the tool refused is not drift: the model got it wrong.
 */
export interface ToolInputDrift {
  /** The tool's name as the model called it. */
  tool: string;
  /** The call (`toolu_…`). */
  toolUseId: string;
  /** What did not match, one `path: message` per line. */
  issues: string;
}

/**
 * Where tool renderers emit {@link ToolInputDrift}, once per call per page.
 * The collector (`reports/tool-input-drift`) drains it.
 */
export const toolInputDriftSink = defineReportSink<ToolInputDrift>();

const emitted = new Set<string>();

/** Emit `drift` unless this page already did for its call. */
export function emitToolInputDrift(drift: ToolInputDrift): void {
  if (emitted.has(drift.toolUseId)) return;
  emitted.add(drift.toolUseId);
  toolInputDriftSink.emit(drift);
}
