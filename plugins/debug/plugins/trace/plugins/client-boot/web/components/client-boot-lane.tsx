import { type ReactElement } from "react";
import {
  ClientBootSectionSchema,
} from "@plugins/debug/plugins/trace/plugins/client-boot/core";
import { BootProfileGantt } from "@plugins/debug/plugins/boot-profile/web";
import type { BootTrace } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text, SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import type { TraceLaneProps } from "@plugins/debug/plugins/trace/plugins/engine/web";

/** Human-readable byte size (KB up to 1 MB, then MB). */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// The client-boot section rendered as the SAME Gantt as Debug → Boot Profile:
// the section minus its `assetRollup` IS a structurally-valid BootTrace (the
// compile-time pin lives in core/section.ts), so the reassembly is a plain
// destructure — the trimmed assets simply render fewer rows, and the rollup
// caption states the full transfer cost the trim folded away. The section's
// offsets are on the client's own clock, so the Gantt keeps its own axis
// inside the card, never the trace window's.
//
// `TraceLaneProps.onSelect` is intentionally not wired: BootProfileGantt owns
// its own hover → bottom-strip detail via ProfilingContext and exposes no
// selection callback.
export function ClientBootLane({ payload }: TraceLaneProps): ReactElement {
  const parsed = ClientBootSectionSchema.safeParse(payload);
  if (!parsed.success) {
    return (
      // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band
      <Stack gap="xs" className="border-b px-lg py-sm">
        <SectionLabel>Client boot</SectionLabel>
        <Placeholder tone="muted">
          No client boot trace recorded for this page load.
        </Placeholder>
      </Stack>
    );
  }
  const { assetRollup, ...bootFields } = parsed.data;
  const trace: BootTrace = bootFields;

  return (
    <Stack gap="none" className="border-b">
      <Stack direction="row" align="center" gap="sm" className="px-lg py-sm">
        <SectionLabel>Client boot</SectionLabel>
        <Badge variant="muted" mono>
          {assetRollup.count} assets · {formatBytes(assetRollup.transferSize)}
        </Badge>
        {assetRollup.droppedCount > 0 && (
          <Text as="span" variant="caption" tone="muted">
            top {trace.assets.length} shown · {assetRollup.droppedCount} rolled
            up ({formatBytes(assetRollup.decodedBodySize)} decoded total)
          </Text>
        )}
      </Stack>
      {/* BootProfileGantt is a full Column (scrolling body) — it needs a
          definite height inside this auto-height lane stack or its body
          collapses; the Gantt scrolls within. */}
      <div className="h-[32rem]">
        <BootProfileGantt trace={trace} />
      </div>
    </Stack>
  );
}
