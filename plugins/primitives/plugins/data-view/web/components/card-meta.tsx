import { Fragment, type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { FieldDef } from "../../core";
import type { useResolveCell } from "../cell-slot";
import type { useResolveCellEditor } from "../cell-editor-slot";
import type { CardFields } from "../internal/card-fields";
import { useResolveFieldIcon } from "../internal/use-field-icon";
import { FieldCell } from "./field-cell";
import { isFieldValueEmpty } from "./editable-cell";

export interface CardMetaProps {
  /** The card's text partition (`partitionCardFields` over the view's
   *  visible fields) — computed once per view, not per card. */
  fields: CardFields<unknown>;
  row: unknown;
  resolveCell: ReturnType<typeof useResolveCell>;
  resolveEditor: ReturnType<typeof useResolveCellEditor>;
  /** Extra classes on the title text (the row's tone, `rowToneClass`). */
  titleClassName?: ClassName;
}

/**
 * A card's text: three fixed-height lines, each drawn whenever the VIEW has
 * fields for it — even when this row's values are all empty — so every card of
 * a view is the same height.
 *
 * 1. **Title** — the primary field, truncated, then the indicators.
 * 2. **Subtitle** — the text fields, joined with "·".
 * 3. **Tokens** — every other field as icon + value (numbers in the code
 *    role), on ONE line that never wraps and fades out at its end.
 *
 * An empty value is omitted (`isFieldValueEmpty`), never drawn as "Empty".
 */
export function CardMeta({
  fields,
  row,
  resolveCell,
  resolveEditor,
  titleClassName,
}: CardMetaProps): ReactNode {
  const resolveIcon = useResolveFieldIcon();
  const cell = (field: FieldDef<unknown>) => (
    <FieldCell
      field={field}
      row={row}
      resolveCell={resolveCell}
      resolveEditor={resolveEditor}
      display="inline"
    />
  );
  const present = (list: readonly FieldDef<unknown>[]) =>
    list.filter((f) => !isFieldValueEmpty(f, row));
  const indicators = present(fields.indicators);
  const subtitle = present(fields.subtitle);
  const tokens = present(fields.tokens);

  return (
    <Stack gap="none">
      <Line className="h-lh gap-xs text-label">
        <Fill>
          <Text variant="label" className={titleClassName}>
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
      {fields.subtitle.length > 0 ? (
        <Line className="h-lh text-caption">
          <Text variant="caption" tone="muted">
            {subtitle.map((f, i) => (
              <Fragment key={f.id}>
                {i > 0 ? " · " : null}
                {cell(f)}
              </Fragment>
            ))}
          </Text>
        </Line>
      ) : null}
      {fields.tokens.length > 0 ? (
        <Clip axis="x" className="clip-fade-end">
          <Line className="h-lh gap-md text-caption">
            {tokens.map((f) => {
              const icon = f.icon ?? resolveIcon(f.type ?? "text");
              const numeric = typeof f.value?.(row) === "number";
              return (
                <Line key={f.id} className={cn("gap-2xs", rigidClass())}>
                  {icon ? (
                    <Icon
                      icon={icon}
                      className="size-3.5 text-muted-foreground"
                    />
                  ) : null}
                  <Text variant={numeric ? "code" : "caption"} tone="muted">
                    {cell(f)}
                  </Text>
                </Line>
              );
            })}
          </Line>
        </Clip>
      ) : null}
    </Stack>
  );
}
