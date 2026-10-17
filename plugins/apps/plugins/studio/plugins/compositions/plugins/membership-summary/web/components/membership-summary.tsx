import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge, type BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { MembershipState } from "@plugins/plugin-meta/plugins/closure/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";

/** Display order + badge color for each membership state in the summary. */
const SUMMARY_ROWS: { state: MembershipState; label: string; variant: BadgeVariant }[] = [
  { state: "entry", label: "Entry", variant: "primary" },
  { state: "required", label: "Required", variant: "primary" },
  { state: "contributor", label: "Contributor", variant: "success" },
  { state: "via-contributor", label: "Via contributor", variant: "success" },
  { state: "available", label: "Available", variant: "info" },
  { state: "excluded", label: "Excluded", variant: "muted" },
];

/** The states that count toward the bundle size. */
const BUNDLE_STATES = new Set<MembershipState>([
  "entry",
  "required",
  "contributor",
  "via-contributor",
]);

export function MembershipSummary({
  membership,
}: {
  membership: Map<PluginId, MembershipState>;
}) {
  const counts = new Map<MembershipState, number>();
  let bundle = 0;
  for (const state of membership.values()) {
    counts.set(state, (counts.get(state) ?? 0) + 1);
    if (BUNDLE_STATES.has(state)) bundle += 1;
  }

  return (
    <Stack gap="sm">
      <Stack direction="row" align="baseline" gap="sm">
        <Text variant="heading">{bundle}</Text>
        <Text variant="caption" tone="muted">
          plugins bundled / {membership.size} total
        </Text>
      </Stack>
      <Cluster gap="xs">
        {SUMMARY_ROWS.map(({ state, label, variant }) => (
          <Badge key={state} variant={variant} tooltip={label}>
            {label} {counts.get(state) ?? 0}
          </Badge>
        ))}
      </Cluster>
    </Stack>
  );
}
