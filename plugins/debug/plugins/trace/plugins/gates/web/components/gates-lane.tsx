import { type ReactElement } from "react";
import { z } from "zod";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  Text,
  SectionLabel,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import type { TraceLaneProps } from "@plugins/debug/plugins/trace/plugins/engine/web";
import { formatDuration } from "@plugins/fields/plugins/duration/core";

// Web mirror of the gates section (layer → occupancy gauge). Parsed loudly since
// the snapshot endpoint keeps `events` sections opaque.
const GatesSchema = z.record(
  z.string(),
  z.object({
    active: z.number(),
    queued: z.number(),
    max: z.number(),
    holders: z
      .array(z.object({ label: z.string(), heldMs: z.number() }))
      .optional(),
  }),
);

// Gate occupancy at the trip instant — a point-in-time strip (NOT time bars):
// one chip per layer `active/max (+queued)`, saturated gates escalated to
// warning/destructive so a bottleneck jumps out. Layer names share the vocabulary
// of the spans' per-layer waits, so this joins the same instant. Below the
// strip, each gate whose owner names its holders says who held it (longest
// first) — who the queued ops were waiting behind.
export function GatesLane({ payload }: TraceLaneProps): ReactElement {
  const parsed = GatesSchema.safeParse(payload);
  const gates = parsed.success ? Object.entries(parsed.data) : [];
  gates.sort((a, b) => b[1].active - a[1].active);

  return (
    // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band
    <Stack gap="xs" className="border-b px-lg py-sm">
      <SectionLabel>Gates</SectionLabel>
      {gates.length === 0 ? (
        <Placeholder tone="muted">
          No gate occupancy recorded at the trip.
        </Placeholder>
      ) : (
        <Cluster>
          {gates.map(([layer, g]) => {
            const saturated = g.max > 0 && g.active >= g.max;
            const variant =
              g.queued > 0 ? "destructive" : saturated ? "warning" : "muted";
            return (
              <Badge key={layer} variant={variant} mono>
                {layer} {g.active}/{g.max}
                {g.queued > 0 && (
                  <Text as="span" variant="caption" className="tabular-nums">
                    {" "}
                    +{g.queued}
                  </Text>
                )}
              </Badge>
            );
          })}
        </Cluster>
      )}
      {gates
        .filter(([, g]) => g.holders !== undefined && g.holders.length > 0)
        .map(([layer, g]) => (
          <Text key={layer} variant="caption" tone="muted">
            {layer} held by{" "}
            {g
              .holders!.map((h) => `${h.label} (${formatDuration(h.heldMs)})`)
              .join(", ")}
          </Text>
        ))}
    </Stack>
  );
}
