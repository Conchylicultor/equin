import { type ReactElement } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { SectionLabel, Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import {
  useCompositionData,
  useActiveComposition,
  useCompareComposition,
  useDiffMap,
  setActiveComposition,
  setCompareComposition,
} from "@plugins/plugin-meta/plugins/composition/web";
import type { CompositionManifest } from "@plugins/plugin-meta/plugins/closure/core";
import { DiffDelta } from "./diff-delta";

/** Default A / B for compare mode — the with/without self-improvement anchor demo. */
export const DEFAULT_A = "agent-manager";
export const DEFAULT_B = "agent-manager-lean";

/**
 * The compare pane's body: pick two compositions (A into the active slot, B into
 * the compare slot) and read the symmetric difference of their bundles. Both
 * pickers write the shared store, which is what puts the Explorer tree into its
 * diff color scheme.
 */
export function CompareView(): ReactElement {
  const { manifests } = useCompositionData();
  const active = useActiveComposition();
  const compare = useCompareComposition();
  const diff = useDiffMap();

  if (manifests.length === 0) {
    return (
      <Text variant="caption" tone="muted">
          No named compositions to compare.
      </Text>
    );
  }

  return (
    <Stack gap="lg">
        <Text variant="caption" tone="muted">
          Pick two compositions; the Explorer tints each plugin by which bundle it
          lands in. The delta below is the symmetric difference of the two bundles.
        </Text>

        <CompositionPicker
          label="A"
          manifests={manifests}
          selected={active?.name ?? null}
          onSelect={(m) => setActiveComposition(structuredClone(m))}
        />
        <CompositionPicker
          label="B"
          manifests={manifests}
          selected={compare?.name ?? null}
          onSelect={(m) => setCompareComposition(structuredClone(m))}
        />

        {active && compare && diff ? (
          <DiffDelta diff={diff} nameA={active.name} nameB={compare.name} />
        ) : (
          <Text variant="caption" tone="muted">
            Select both A and B to see the delta.
          </Text>
        )}
    </Stack>
  );
}

function CompositionPicker({
  label,
  manifests,
  selected,
  onSelect,
}: {
  label: string;
  manifests: CompositionManifest[];
  selected: string | null;
  onSelect: (m: CompositionManifest) => void;
}) {
  return (
    <Stack gap="2xs">
      <SectionLabel>{label}</SectionLabel>
      <Stack gap="2xs">
        {/* eslint-disable-next-line data-view/no-adhoc-row-list -- single-select picker control for compare mode, not a browsable data surface */}
        {manifests.map((m) => (
          <Row
            key={m.name}
            selected={selected === m.name}
            onClick={() => onSelect(m)}
          >
            <span className="truncate">{m.name}</span>
          </Row>
        ))}
      </Stack>
    </Stack>
  );
}
