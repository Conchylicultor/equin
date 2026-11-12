import { type ReactElement } from "react";
import { StallSectionSchema } from "@plugins/debug/plugins/trace/plugins/stall/core";
import { formatDuration } from "@plugins/debug/plugins/profiling/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text, SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import type { TraceLaneProps } from "@plugins/debug/plugins/trace/plugins/engine/web";

// The stall section rendered as a HISTOGRAM CARD (not time bars — the samples are
// aggregated over the whole freeze window). Header states the freeze duration
// (from the trigger) + sample count/rate; then the ranked innermost frames ("what
// was hot") and the collapsed call-path signatures ("how we got there"). This is
// the sole surface that answers *what code froze the loop* — the old
// stall-profiles.jsonl dumped it to a dead-end nobody read.
export function StallLane({ payload, trace }: TraceLaneProps): ReactElement {
  const parsed = StallSectionSchema.safeParse(payload);
  if (!parsed.success) {
    return (
      // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band
      <Stack gap="xs" className="border-b px-lg py-sm">
        <SectionLabel>Stall stacks</SectionLabel>
        <Placeholder tone="muted">No stack samples recorded for this stall.</Placeholder>
      </Stack>
    );
  }
  const { nSamples, sampleRateHz, topLeaves, topStacks } = parsed.data;

  return (
    // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band
    <Stack gap="sm" className="border-b px-lg py-sm">
      <Stack direction="row" align="center" gap="sm">
        <SectionLabel>Stall stacks</SectionLabel>
        <Badge variant="destructive" mono>
          froze {formatDuration(trace.trigger.durationMs)}
        </Badge>
        <Badge variant="muted" mono>
          {nSamples} samples · {sampleRateHz} Hz
        </Badge>
      </Stack>

      {topLeaves.length === 0 ? (
        <Placeholder tone="muted">No frames captured during the freeze.</Placeholder>
      ) : (
        <Stack gap="2xs">
          <Text as="div" variant="caption" tone="muted">
            Top frames
          </Text>
          {topLeaves.map((leaf) => (
            <Stack key={leaf.key} direction="row" align="center" gap="sm">
              <Fill>
                <Text as="div" variant="caption" className="truncate font-mono">
                  {leaf.key}
                </Text>
              </Fill>
              <Badge variant="muted" mono>
                {leaf.pct}%
              </Badge>
            </Stack>
          ))}
        </Stack>
      )}

      {topStacks.length > 0 && (
        <Stack gap="2xs">
          <Text as="div" variant="caption" tone="muted">
            Stack signatures
          </Text>
          {topStacks.map((s, i) => (
            <Stack key={i} direction="row" align="start" gap="sm">
              <Badge variant="muted" mono>
                {s.pct}%
              </Badge>
              <Fill>
                <Text as="div" variant="caption" className="break-all font-mono">
                  {s.stack}
                </Text>
              </Fill>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
