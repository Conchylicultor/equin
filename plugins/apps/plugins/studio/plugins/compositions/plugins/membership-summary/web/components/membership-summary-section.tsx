import type { ReactElement } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  setViewHost,
  useActiveComposition,
  useActiveMembership,
  useViewHost,
} from "@plugins/plugin-meta/plugins/composition/web";
import type { HostId } from "@plugins/framework/plugins/plugin-id/core";
import { MembershipSummary } from "./membership-summary";

const HOST_OPTIONS: readonly SegmentedOption<HostId>[] = [
  {
    id: "desktop",
    label: "Desktop",
    tooltip: "On the computer: machine/ and central/ imports count",
  },
  {
    id: "browser",
    label: "Browser",
    tooltip:
      "In a browser host: only portable server/ and the page — machine/ and central/ imports do not count",
  },
];

/**
 * Section host for the membership summary, with the host the closure is viewed
 * on: Desktop or Browser (every Studio surface follows it — the explorer tint,
 * inclusion paths, contributor impacts). It starts on the widest host the row
 * declares. `membership` is null for the frame before the pane's seed effect
 * populates the active-composition store, and whenever the draft is cleared.
 */
export function MembershipSummarySection(): ReactElement {
  const membership = useActiveMembership();
  const active = useActiveComposition();
  const host = useViewHost();

  if (!membership || !active || !host) {
    return (
      <Text variant="caption" tone="muted">
        No active composition.
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      <Stack direction="row" align="center" gap="sm">
        <SegmentedControl
          label="Host"
          options={HOST_OPTIONS}
          value={host}
          onChange={setViewHost}
        />
        <Text variant="caption" tone="muted">
          declared for {active.hosts.join(" + ")}
        </Text>
      </Stack>
      <MembershipSummary membership={membership} />
    </Stack>
  );
}
