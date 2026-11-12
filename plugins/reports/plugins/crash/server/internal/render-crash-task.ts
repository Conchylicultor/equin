import { serializeUiContext } from "@plugins/primitives/plugins/ui-context/core";
import type { ReportRow } from "@plugins/reports/server";
import { versionSkewExplains } from "@plugins/reports/core";
import { CrashPayloadSchema, formatResizeLoopTrace } from "../../core";
import type { CrashPayload } from "../../core";

const STACK_MAX = 16_000;
const COMPONENT_STACK_MAX = 8_000;

// Truncate the middle, keeping head + tail (the innermost frames are usually the
// root cause; the closing context matters too). Mirrors the clamp the reports
// engine previously applied to crash columns at ingest — now done at render so
// the task description never balloons the markdown renderer.
function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const omitted = value.length - max;
  return `${value.slice(0, head)}\n… [truncated ${omitted} chars] …\n${value.slice(value.length - tail)}`;
}

function crashOf(row: ReportRow): CrashPayload {
  // The row's data was validated by CrashPayloadSchema at ingest, so this is a
  // total parse; failure would be a corrupted row (surfaced loudly).
  return CrashPayloadSchema.parse(row.data);
}

export function renderCrashTask(row: ReportRow): {
  title: string;
  description: string;
} {
  return { title: renderTitle(row), description: renderDescription(row) };
}

function renderTitle(row: ReportRow): string {
  const data = crashOf(row);
  const prefix = data.errorType ? `${data.errorType}: ` : "";
  const stalePrefix = versionSkewExplains(row) ? "[Stale tab] " : "";
  // Tag known-benign noise so the title itself reads as "expected", matching the
  // muted notification — not just a dimmed row with no explanation.
  const noisePrefix = row.noise ? "[noise] " : "";
  const raw = `${stalePrefix}${noisePrefix}[crash] ${prefix}${row.message}`;
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function renderDescription(row: ReportRow): string {
  const data = crashOf(row);
  const recurrence = row.taskId != null;
  const stack = data.stack != null ? clamp(data.stack, STACK_MAX) : null;
  const componentStack =
    data.componentStack != null
      ? clamp(data.componentStack, COMPONENT_STACK_MAX)
      : null;

  const lines: string[] = [];
  // Stored at record time: judged against what the server served and retired
  // then, never against today's, which has moved on since.
  if (versionSkewExplains(row)) {
    lines.push(
      `**Origin:** stale frontend tab (bundle ${row.lastBuildId}) — every occurrence proved version skew (a failed load: a file of the tab's build the server answered 404 for and confirmed retired; a stored entry: written by another build). A reload fixes it.`,
    );
    lines.push("");
  } else if (row.staleOrigin) {
    lines.push(
      `**Origin:** only seen from outdated tabs so far (bundle ${row.lastBuildId}). That does not explain it: no occurrence proved version skew, so the bug is in that bundle's own code (or the server's), and is live until a build that fixes it.`,
    );
    lines.push("");
  }
  if (recurrence) {
    lines.push(
      `**Recurrence** — this fingerprint previously had a task that was dropped. It just happened again.`,
    );
    lines.push("");
  }
  lines.push(`**Source:** ${row.source}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**Fingerprint:** ${row.fingerprint}`);
  lines.push(`**Count:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  if (data.slot) {
    const suffix = data.label ? ` (label: ${data.label})` : "";
    lines.push(`**Slot:** ${data.slot}${suffix}`);
  }
  // The composition lineage of the crashed subtree, as the same `<ui-context …>`
  // token the element-picker emits — so it renders as the existing inline chip
  // and reads to an agent as a shape it already knows. Conditional: only the
  // react-boundary source has a DOM position to walk from.
  if (data.uiContext) {
    lines.push(serializeUiContext(data.uiContext, "crash"));
  }
  if (row.url) lines.push(`**URL:** ${row.url}`);
  if (row.userAgent) lines.push(`**User-Agent:** ${row.userAgent}`);
  lines.push("");
  lines.push(`**Error**`);
  lines.push("```");
  lines.push(`${data.errorType ?? "Error"}: ${row.message}`);
  if (stack) lines.push(stack);
  lines.push("```");
  if (componentStack) {
    lines.push("");
    lines.push("**Component stack**");
    lines.push("```");
    lines.push(componentStack);
    lines.push("```");
  }
  if (data.resizeLoop) {
    lines.push("");
    lines.push(formatResizeLoopTrace(data.resizeLoop));
  }
  return lines.join("\n");
}
