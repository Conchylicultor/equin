import type { ReportRow } from "@plugins/reports/server";
import {
  PopoverAnchorLostPayloadSchema,
  type PopoverAnchorLostPayload,
} from "../../core";

// Notification re-arm window: whatever hides the anchor does so on a path the
// user takes again, so the bell resurfaces it every 6h rather than collapsing
// forever onto the first sighting. Same policy as viewport-escape.
export const POPOVER_ANCHOR_LOST_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

type ElementInfo = PopoverAnchorLostPayload["anchor"];

function describe(label: string, info: ElementInfo): string[] {
  return [
    `- **${label}:** ${info.element}`,
    ...(info.path ? [`  - lineage: \`${info.path}\``] : []),
    ...(info.source ? [`  - source: \`${info.source}\``] : []),
    ...(info.owner ? [`  - owner: \`${info.owner}\``] : []),
    ...(info.selector ? [`  - selector: \`${info.selector}\``] : []),
  ];
}

export function renderPopoverAnchorLostTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at ingest, so this is a total parse; a failure is
  // a corrupted row and should surface loudly.
  const data = PopoverAnchorLostPayloadSchema.parse(row.data);
  const noisePrefix = row.noise ? "[noise] " : "";
  const what = data.cause === "detached" ? "removed" : "hidden";
  const rawTitle = `${noisePrefix}[popover-anchor-lost] ${data.anchor.element} ${what} under its open popover`;
  const title =
    rawTitle.length > 120 ? `${rawTitle.slice(0, 117)}...` : rawTitle;

  const lines = [
    `**An open popover's anchor lost its box.** ${data.message} Floating UI measures such an element as an empty rect at the viewport's origin, so the panel used to jump to the screen's top-left corner; ui-kit's \`PopoverContent\` now keeps it at its last place (\`steady-anchor.ts\`) and files this. The jump is gone, the cause is not: something hides or replaces the anchor while its popover is open.`,
    "",
    `**Fault**`,
    `- **Cause:** \`${data.cause}\` — ${data.cause === "detached" ? "the anchor element left the document (unmounted, or re-rendered into a new node)" : "the anchor is in the document but generates no box"}`,
    ...describe("Popover", data.popover),
    ...describe("Anchor", data.anchor),
    ...(data.hiddenBy
      ? describe("Hidden by (nearest display: none)", data.hiddenBy)
      : []),
    "",
    `**Report**`,
    `- **Source:** ${row.source}`,
    `- **Worktree:** ${row.worktree}`,
    `- **Fingerprint:** ${row.fingerprint}`,
    `- **Count:** ${row.count}`,
    `- **First seen:** ${row.firstSeenAt.toISOString()}`,
    `- **Last seen:** ${row.lastSeenAt.toISOString()}`,
    ...(row.url ? [`- **URL:** ${row.url}`] : []),
    ...(row.userAgent ? [`- **User-Agent:** ${row.userAgent}`] : []),
    "",
    `**How to fix**`,
    `Find why the anchor goes away while its popover is open — the element named under "Hidden by" (or, when detached, what remounts the anchor). Either keep the anchor drawn for as long as the popover is open (hold the hiding region open the way \`floating-action\` holds its bar through \`PopupOpenScope\`), or close the popover when its anchor goes. Never hide the panel to mask it.`,
  ];
  return { title, description: lines.join("\n") };
}
