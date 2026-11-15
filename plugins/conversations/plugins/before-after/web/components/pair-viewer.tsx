import type { ReactNode } from "react";
import {
  CompareZoomControls,
  SwipeCompare,
  useCompareZoom,
} from "@plugins/primitives/plugins/diff-view/plugins/swipe-compare/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { BeforeAfterPair } from "../../core";
import { COMPARE_MODES, useCompareState } from "../internal/compare-state";
import { AfterImage, BeforeImage, pairCaption } from "./pair-image";
import { CopyPairIdChip } from "./pair-id-chip";

/**
 * One pair, large: its caption (title, id chip, `route · W × H · before →
 * after`), the mode control (Swipe / Side by side / Flip), the zoom controls
 * (− % + · Fit width · Fit height · 1:1 — scroll to zoom, drag to pan) and the
 * comparison filling the rest of the box, fitted to its width at first (a
 * full-page capture reads from its top). The mode and the
 * divider are the pane's ({@link useCompareState}), so the pane's viewer and
 * the full-screen one show the same comparison. `trailing` ends the caption
 * row (the full-screen view's close).
 */
export function PairViewer(props: PairViewerProps): ReactNode {
  // A new pair starts its own zoom (and flip shows its after side).
  return <PairViewerBody key={props.pair.id} {...props} />;
}

interface PairViewerProps {
  pair: BeforeAfterPair;
  trailing?: ReactNode;
  className?: string;
  /** Around the comparison only (the full-screen view keeps its side buttons clear). */
  stageClassName?: ClassName;
}

function PairViewerBody({
  pair,
  trailing,
  className,
  stageClassName,
}: PairViewerProps): ReactNode {
  const { mode, setMode, at, setAt } = useCompareState();
  const zoom = useCompareZoom({ width: pair.width, height: pair.height });
  return (
    <Stack gap="smd" className={cn("min-h-0", className)}>
      <Stack direction="row" align="center" gap="smd" wrap>
        <Fill className="min-w-40">
          <Stack gap="2xs">
            <Inline gap="xsm" align="center">
              <Text variant="label">{pair.title}</Text>
              <CopyPairIdChip id={pair.id} />
            </Inline>
            <Text variant="caption" tone="muted">
              {pairCaption(pair)}
            </Text>
          </Stack>
        </Fill>
        <SegmentedControl
          label="Compare as"
          options={COMPARE_MODES}
          value={mode}
          onChange={setMode}
          variant="ghost"
        />
        <CompareZoomControls zoom={zoom} />
        {trailing}
      </Stack>
      <Fill axis="y" className={stageClassName}>
        <SwipeCompare
          before={<BeforeImage pair={pair} />}
          after={<AfterImage pair={pair} />}
          beforeLabel="Before"
          afterLabel="After"
          mode={mode}
          at={at}
          onAtChange={setAt}
          zoom={zoom}
        />
      </Fill>
    </Stack>
  );
}
