import { Fragment, type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  Text,
  rolePickClass,
  rolePickScope,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import type { RolePart } from "@plugins/primitives/plugins/css/plugins/text/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { DATA_VIEW_PICKS } from "@plugins/ui/plugins/tokens/plugins/data-view/core";
import { dataPart, type FieldDef } from "../../core";
import type { useResolveCell } from "../cell-slot";
import type { useResolveCellEditor } from "../cell-editor-slot";
import type { CardFields } from "../internal/card-fields";
import { useResolveFieldIcon } from "../internal/use-field-icon";
import { FieldCell } from "./field-cell";
import { isFieldValueEmpty } from "./editable-cell";

export interface CardMetaProps {
  /** The card's slots (`cardFieldsOf` over the view's placement) —
   *  computed once per view, not per card. */
  fields: CardFields<unknown>;
  row: unknown;
  resolveCell: ReturnType<typeof useResolveCell>;
  resolveEditor: ReturnType<typeof useResolveCellEditor>;
  /** Extra classes on the title text (the row's tone, `rowToneClass`). */
  titleClassName?: ClassName;
}

/**
 * One card line's box: the part's pick scope (`rolePickScope`, so the line
 * itself wears the picked type and its `1lh` box is the picked rung's line
 * height) plus the room above it. The `Line` under it carries the pick
 * classes; the words inside pick again (`<Text pick>`).
 */
function PickedLine({
  part,
  className,
  children,
}: {
  part: RolePart;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={className} style={rolePickScope(part)}>
      {children}
    </div>
  );
}

/**
 * The subtitle under a `cardSubtitleLines` other than 1: the words wrap and
 * clamp at that many lines (`line-clamp-card-subtitle`) instead of truncating
 * on one. A style query on the token, so the default (1) keeps the
 * single-line truncation exactly. The words fill the box's height, so they
 * start at its top rather than centred in the taller line box.
 */
const SUBTITLE_CLAMP =
  "[@container_not_style(--card-subtitle-lines:1)]:line-clamp-card-subtitle [@container_not_style(--card-subtitle-lines:1)]:whitespace-normal [@container_not_style(--card-subtitle-lines:1)]:h-full";

/**
 * A card's text: three fixed-height lines, each drawn whenever the VIEW has
 * fields for it — even when this row's values are all empty — so every card of
 * a view is the same height.
 *
 * 1. **Title** — the title slot, truncated, then the `afterTitle` marks.
 * 2. **Subtitle** — the `line2` slot, joined with "·" (clamped to
 *    `cardSubtitleLines`, its box that many lines tall).
 * 3. **Tokens** — the `trail` slot as icon + value (numbers in their own
 *    pick), on ONE line that never wraps and fades out at its end, then the
 *    `edge` field at its far end. Each value is drawn in the `token` context
 *    (`FieldDef.token` first).
 *
 * Every size is a `tokens/data-view` token (type picks, line boxes, gaps,
 * token gap, icon size and inks) whose default is the look before the group
 * existed. An empty value is omitted (`isFieldValueEmpty`), never drawn as
 * "Empty".
 */
export function CardMeta({
  fields,
  row,
  resolveCell,
  resolveEditor,
  titleClassName,
}: CardMetaProps): ReactNode {
  const resolveIcon = useResolveFieldIcon();
  const cell = (field: FieldDef<unknown>, context?: "token") => (
    <FieldCell
      field={field}
      row={row}
      resolveCell={resolveCell}
      resolveEditor={resolveEditor}
      display="inline"
      context={context}
    />
  );
  const present = (list: readonly FieldDef<unknown>[]) =>
    list.filter((f) => !isFieldValueEmpty(f, row));
  const indicators = present(fields.afterTitle);
  const subtitle = present(fields.line2);
  const tokens = present(fields.trail);
  const edge =
    fields.edge && !isFieldValueEmpty(fields.edge, row) ? fields.edge : null;
  const P = DATA_VIEW_PICKS;

  return (
    <Stack gap="none" {...dataPart("dv.card-meta")}>
      <PickedLine part={P.cardTitle}>
        <Line
          className={cn(
            "h-card-title-line gap-xs",
            rolePickClass(P.cardTitle.fallback),
          )}
        >
          <Fill>
            <Text
              pick={P.cardTitle}
              className={titleClassName}
              {...dataPart("dv.card-title")}
            >
              {fields.title && !isFieldValueEmpty(fields.title, row)
                ? cell(fields.title)
                : null}
            </Text>
          </Fill>
          {indicators.map((f) => (
            <span key={f.id} className={rigidClass()}>
              {cell(f)}
            </span>
          ))}
        </Line>
      </PickedLine>
      {fields.line2.length > 0 ? (
        <PickedLine part={P.cardSubtitle} className="pt-card-subtitle">
          <Line
            className={cn(
              "h-[calc(var(--card-subtitle-lines)*var(--card-subtitle-line))]",
              rolePickClass(P.cardSubtitle.fallback),
            )}
          >
            <Text
              pick={P.cardSubtitle}
              className={cn("text-card-subtitle-ink", SUBTITLE_CLAMP)}
              {...dataPart("dv.card-subtitle")}
            >
              {subtitle.map((f, i) => (
                <Fragment key={f.id}>
                  {i > 0 ? " · " : null}
                  {cell(f)}
                </Fragment>
              ))}
            </Text>
          </Line>
        </PickedLine>
      ) : null}
      {fields.trail.length > 0 || fields.edge ? (
        <PickedLine part={P.cardToken} className="pt-card-tokens">
          <Clip axis="x" className="clip-fade-end">
            <Line
              className={cn(
                "h-card-tokens-line gap-card-token",
                rolePickClass(P.cardToken.fallback),
              )}
              {...dataPart("dv.card-tokens")}
            >
              {tokens.map((f) => {
                const icon = f.icon ?? resolveIcon(f.type ?? "text");
                const numeric = typeof f.value?.(row) === "number";
                return (
                  <Line
                    key={f.id}
                    className={cn("gap-card-token-icon", rigidClass())}
                    {...dataPart("dv.card-token")}
                  >
                    {icon ? (
                      <Icon
                        icon={icon}
                        className="size-card-token-icon text-card-token-icon-ink"
                        {...dataPart("dv.card-token-icon")}
                      />
                    ) : null}
                    <Text
                      pick={numeric ? P.cardTokenNumeric : P.cardToken}
                      className="text-card-token-ink"
                    >
                      {cell(f, "token")}
                    </Text>
                  </Line>
                );
              })}
              {edge ? (
                <>
                  <Fill />
                  <Text
                    pick={P.cardToken}
                    className={cn("text-card-token-ink", rigidClass())}
                    {...dataPart("dv.card-edge")}
                  >
                    {cell(edge, "token")}
                  </Text>
                </>
              ) : null}
            </Line>
          </Clip>
        </PickedLine>
      ) : null}
    </Stack>
  );
}
