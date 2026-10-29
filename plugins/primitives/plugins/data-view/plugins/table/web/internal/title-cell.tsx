import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  rolePickClass,
  rolePickScope,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { DATA_VIEW_PICKS } from "@plugins/ui/plugins/tokens/plugins/data-view/core";
import { dataPart } from "@plugins/primitives/plugins/data-view/core";
import {
  CoverFrame,
  drawnSubtitleTerms,
  FieldCell,
  PrimaryActionSlot,
  SubtitleRun,
  type CoverContent,
  type FieldDef,
  type ItemActionArms,
  type useResolveCell,
  type useResolveCellEditor,
} from "@plugins/primitives/plugins/data-view/web";

const P = DATA_VIEW_PICKS;

/** What a stacked title cell draws, the same for every row of one render. */
export interface StackedTitle {
  title: FieldDef<unknown>;
  /** Row-state marks, after the title on its line. */
  indicators: readonly FieldDef<unknown>[];
  /** The text fields of the second line (`SubtitleRun`). */
  subtitle: readonly FieldDef<unknown>[];
  /** Which of `subtitle` render as a chip (`useIsChipField`). */
  subtitleIsChip: readonly boolean[];
  resolveCell: ReturnType<typeof useResolveCell>;
  resolveEditor: ReturnType<typeof useResolveCellEditor>;
}

/**
 * A soft table's `titleCell: "stacked"` cell — a card's text in one column:
 * the title and its indicators, then the subtitle run of text fields (the
 * list's own run, `SubtitleRun`). Each line's type is a DataView pick
 * (`titleCell` / `titleCellSubtitle`), at the full rung: the table's `xs`
 * control size is about its controls, not these words. Its scope is a
 * box-less wrapper per line, as `<Text pick>` draws one.
 */
export function StackedTitleCell({
  spec,
  row,
}: {
  spec: StackedTitle;
  row: unknown;
}): ReactNode {
  const terms = drawnSubtitleTerms(spec.subtitle, row);
  return (
    <Stack gap="none" {...dataPart("dv.title-cell")}>
      <span className="contents" style={rolePickScope(P.titleCell)}>
        {/* One line: the title truncates, its marks keep their size after it
            (a block-level cell — an identifier's — cannot push them down). */}
        <Line
          className={cn(
            rolePickClass(P.titleCell.fallback, false),
            "gap-xs text-foreground",
          )}
          {...dataPart("dv.title-cell-title")}
        >
          <Text>
            <FieldCell
              field={spec.title}
              row={row}
              resolveCell={spec.resolveCell}
              resolveEditor={spec.resolveEditor}
              display="inline"
            />
          </Text>
          {spec.indicators.map((field) => (
            <span key={field.id} className={rigidClass()}>
              <FieldCell
                field={field}
                row={row}
                resolveCell={spec.resolveCell}
                resolveEditor={spec.resolveEditor}
                display="inline"
              />
            </span>
          ))}
        </Line>
      </span>
      {terms.length > 0 ? (
        <span className="contents" style={rolePickScope(P.titleCellSubtitle)}>
          <Text
            as="div"
            className={cn(
              rolePickClass(P.titleCellSubtitle.fallback, false),
              "pt-title-cell-subtitle truncate text-muted-foreground",
            )}
            {...dataPart("dv.title-cell-subtitle")}
          >
            <SubtitleRun
              fields={spec.subtitle}
              isChip={spec.subtitleIsChip}
              terms={terms}
              seam={null}
              row={row}
              resolveCell={spec.resolveCell}
              resolveEditor={spec.resolveEditor}
            />
          </Text>
        </span>
      ) : null}
    </Stack>
  );
}

/**
 * A table's cover cell (`cover: true`): the row's cover as a thumbnail, sized
 * and rounded by the soft thumb tokens (narrower under a 640px table when the
 * theme sets `softThumbNarrowW`), with the surface's primary action over it —
 * revealed by the row's hover, painted at rest while active. A table row is
 * no `<button>`, so the action sits inside the frame.
 */
export function CoverCell({
  content,
  primary,
  row,
  hasChildren,
}: {
  content: CoverContent | null;
  primary: ItemActionArms<unknown> | null;
  row: unknown;
  hasChildren: boolean;
}): ReactNode {
  return (
    <div {...dataPart("dv.thumb")}>
      <CoverFrame
        size="thumb"
        content={content}
        className="size-soft-thumb rounded-soft-thumb @max-[640px]:w-[var(--soft-thumb-narrow-w,var(--soft-thumb-w))]"
      >
        {primary ? (
          <Layer decorative>
            <PrimaryActionSlot
              primary={primary}
              target={{ row, hasChildren }}
              className="size-full"
            />
          </Layer>
        ) : null}
      </CoverFrame>
    </div>
  );
}
