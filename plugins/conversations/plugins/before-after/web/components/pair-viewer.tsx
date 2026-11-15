import type { ReactNode } from "react";
import {
  CompareZoomControls,
  SwipeCompare,
  useCompareZoom,
} from "@plugins/primitives/plugins/diff-view/plugins/swipe-compare/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { BeforeAfterPair } from "../../core";
import { COMPARE_MODES, useCompareState } from "../internal/compare-state";
import { AfterImage, BeforeImage, pairCaption } from "./pair-image";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";

/**
 * One pair, large: its caption (`route · W × H · before → after`, under its
 * title when `titled` — in a pane the header carries the title), then a
 * toolbar row — the mode switch (Swipe / Side by side / Flip) on the left, the
 * zoom controls (− % + · Fit width · Fit height · 1:1 — scroll to zoom, drag
 * to pan) on the right — and the comparison filling the rest of the box,
 * fitted to its width at first (a full-page capture reads from its top). The
 * mode and the divider are the pane's ({@link useCompareState}), so the
 * pane's viewer and the full-screen one show the same comparison. `trailing`
 * ends the caption row (the full-screen view's close).
 */
export function PairViewer(props: PairViewerProps): ReactNode {
  // A new pair starts its own zoom (and flip shows its after side).
  return <PairViewerBody key={props.pair.id} {...props} />;
}

interface PairViewerProps {
  pair: BeforeAfterPair;
  /** Show the pair's title (and its copy-id button) above the caption — where
   *  no pane header carries it (full screen). */
  titled?: boolean;
  trailing?: ReactNode;
  className?: string;
  /** Around the comparison only (the full-screen view keeps its side buttons clear). */
  stageClassName?: ClassName;
}

function PairViewerBody({
  pair,
  titled = false,
  trailing,
  className,
  stageClassName,
}: PairViewerProps): ReactNode {
  const { mode, setMode, at, setAt } = useCompareState();
  const zoom = useCompareZoom({ width: pair.width, height: pair.height });
  return (
    <Stack gap="smd" className={cn("min-h-0", className)}>
      <Stack direction="row" align="center" gap="smd">
        <Fill>
          <Stack gap="2xs">
            {titled ? <PairTitle pair={pair} /> : null}
            <Line>
              <Text variant="caption" tone="muted">
                {pairCaption(pair)}
              </Text>
            </Line>
          </Stack>
        </Fill>
        {trailing}
      </Stack>
      <Stack direction="row" align="center" justify="between" gap="smd" wrap>
        {/* The modes on a track, so the three read as one switch. */}
        <Inset
          pad="2xs"
          className="rounded-lg border border-border bg-muted/40"
        >
          <SegmentedControl
            label="Compare as"
            options={COMPARE_MODES}
            value={mode}
            onChange={setMode}
            variant="ghost"
            className="gap-2xs"
          />
        </Inset>
        <CompareZoomControls zoom={zoom} />
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

/**
 * The pair's title, one truncating line, with a button copying its `ba-…` id
 * (to cite it) — the id itself stays out of sight. The pane header's title and
 * the full-screen view's.
 */
export function PairTitle({ pair }: { pair: BeforeAfterPair }): ReactNode {
  return (
    <Line className="gap-2xs">
      <Text variant="label">{pair.title}</Text>
      <Rigid>
        <CopyButton text={pair.id} tooltip={`Copy id ${pair.id}`} />
      </Rigid>
    </Line>
  );
}
