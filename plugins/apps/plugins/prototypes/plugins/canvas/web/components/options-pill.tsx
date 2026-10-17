import { useState, type ReactElement, type ReactNode } from "react";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
  useCollapsibleContext,
} from "@plugins/primitives/plugins/collapsible/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  Button,
  ControlSizeProvider,
  Separator,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { WithTooltip } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { ColorPicker } from "@plugins/primitives/plugins/css/plugins/color-picker/web";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  colorPickValue,
  groupOptions,
  humanizeToken,
  optionLabel,
  parseOptionColor,
  pickedColor,
  pickedValue,
  type ColorOption,
  type OptionPicks,
  type PrototypeMeta,
  type PrototypeOption,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { documentOptions, useFramePicks, usePrototypeDetail } from "../context";
import {
  previewedValue,
  prototypeFrames,
  spreadValues,
  type CanvasState,
  type PrototypeFrame,
} from "../internal/canvas-model";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const linkIcon = symbol("link");
const tuneIcon = symbol("tune");
const viewColumnIcon = symbol("view-column");
const paletteIcon = symbol("palette");

/**
 * One prototype frame's options, as a pill ("Mist · Home +3") that opens the
 * options popover: one row per declared option — value chips for a choice,
 * suggestion swatches plus a custom swatch (which opens a color picker in its
 * own popover beside it) for a color — plus per row a link (keep it the same in every
 * frame) and a spread (one frame per value, or per suggestion). Options the
 * page declares under a group (`<meta name="prototype-option-group">`) sit in
 * one collapsible section per group, which names its picks when folded.
 *
 * A color drag previews (`previewPick`: the frame repaints every move, nothing
 * is written) and its end commits (`setPick`: one write). The pill and the
 * swatches show the preview too, so they move with the frame.
 *
 * App DOM, never inside the prototype's page — that is what keeps switchers
 * out of the designs. It always edits ITS frame, so nothing needs
 * disambiguating. Renders nothing for a document with no options. The frame's
 * picks are always known here: the canvas does not exist until they load.
 */
export function OptionsPill({
  frame,
  meta,
}: {
  frame: PrototypeFrame;
  meta: PrototypeMeta;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const { canvas, dispatch } = usePrototypeDetail();
  const options = documentOptions(meta, frame.version);
  const picks = useFramePicks(frame, meta);
  if (options.length === 0) return null;
  const shown = shownPicks(canvas, frame, options, picks);
  return (
    <InlinePopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) return;
        // A drag cut short by the popover closing is dropped, not picked.
        if (canvas.preview?.id === frame.id) dispatch({ type: "clearPreview" });
      }}
      side="top"
      align="center"
      width="builder"
      trigger={
        <Button variant="floating" shape="pill" aria-label="Prototype options">
          <Icon icon={tuneIcon} />
          <PillSummary options={options} picks={shown} />
        </Button>
      }
    >
      <ControlSizeProvider size="xs">
        <Stack gap="sm" role="group" aria-label="Options">
          <PopoverHeading />
          {groupOptions(options).map((group, i) => {
            const rows = group.options.map((option) => (
              <OptionRow
                key={option.name}
                frame={frame}
                option={option}
                value={pickedValue(option, picks)}
                shownValue={pickedValue(option, shown)}
                onPick={(value) =>
                  dispatch({
                    type: "setPick",
                    id: frame.id,
                    option: option.name,
                    value,
                  })
                }
                onClose={() => setOpen(false)}
              />
            ));
            // A run is keyed by its place: two runs may share a label.
            const key = `${String(i)}:${group.label ?? ""}`;
            return group.label === null ? (
              <Stack key={key} gap="sm">
                {rows}
              </Stack>
            ) : (
              <OptionGroupSection
                key={key}
                label={group.label}
                summary={group.options
                  .map((o) => valueLabel(pickedValue(o, shown)))
                  .join(" · ")}
              >
                {rows}
              </OptionGroupSection>
            );
          })}
          {Object.keys(picks).length > 0 ? (
            <Button
              variant="ghost"
              onClick={() => dispatch({ type: "resetPicks", id: frame.id })}
            >
              Reset to defaults
            </Button>
          ) : null}
        </Stack>
      </ControlSizeProvider>
    </InlinePopover>
  );
}

/**
 * The picks a frame's pill shows: its resolved picks, with a color being
 * dragged on it (or on a linked frame) in place of its pick.
 */
function shownPicks(
  canvas: CanvasState,
  frame: PrototypeFrame,
  options: readonly PrototypeOption[],
  picks: OptionPicks,
): OptionPicks {
  for (const option of options) {
    const preview = previewedValue(canvas, frame.id, option.name);
    if (preview !== null) return { ...picks, [option.name]: preview };
  }
  return picks;
}

/** A value as the pill writes it: a token humanized, a custom color as its hex. */
function valueLabel(value: string): string {
  return value.startsWith("#") ? value : humanizeToken(value);
}

/**
 * "Mist · Home" and a dimmed "+3" for the options not named. A color option
 * reads as a dot of its color and its suggestion's name (or its hex).
 */
function PillSummary({
  options,
  picks,
}: {
  options: readonly PrototypeOption[];
  picks: OptionPicks;
}): ReactElement {
  const named = options.slice(0, 2);
  const rest = options.length - named.length;
  return (
    <>
      <Inline as="span" gap="xs" className="tabular-nums">
        {named.map((o, i) => (
          <Inline as="span" gap="xs" key={o.name}>
            {i > 0 ? <span aria-hidden>·</span> : null}
            {o.kind === "color" ? (
              <ColorDot color={pickedColor(o, picks)} />
            ) : null}
            {valueLabel(pickedValue(o, picks))}
          </Inline>
        ))}
      </Inline>
      {rest > 0 ? (
        <span className="text-muted-foreground">+{String(rest)}</span>
      ) : null}
    </>
  );
}

/**
 * One group's options, under a header that folds them: the group's label and
 * a rule while open; folded, the picks it holds ("Status · Flat · Button").
 */
function OptionGroupSection({
  label,
  summary,
  children,
}: {
  label: string;
  summary: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Collapsible defaultOpen>
      <Stack gap="xs">
        <CollapsibleTrigger className="gap-xs text-muted-foreground hover:text-foreground">
          <CollapsibleChevron className="size-3" />
          <SectionLabel as="span" className={rigidClass()}>
            {label}
          </SectionLabel>
          <GroupHeaderTail summary={summary} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Stack gap="sm">{children}</Stack>
        </CollapsibleContent>
      </Stack>
    </Collapsible>
  );
}

/** A group header's tail: a rule while open, the group's picks while folded. */
function GroupHeaderTail({ summary }: { summary: string }): ReactElement {
  const ctx = useCollapsibleContext();
  if (ctx === null)
    throw new Error("GroupHeaderTail renders inside a Collapsible");
  const open = ctx.open;
  return (
    <Fill>
      {open ? (
        <Separator />
      ) : (
        <Text variant="caption" tone="faint">
          {summary}
        </Text>
      )}
    </Fill>
  );
}

/** "Options" and the legend for the row actions. */
function PopoverHeading(): ReactElement {
  const { canvas } = usePrototypeDetail();
  const multi = prototypeFrames(canvas.frames).length > 1;
  return (
    <Stack direction="row" gap="sm" align="center">
      <Text variant="label">Options</Text>
      <Fill />
      <Text variant="caption" tone="faint">
        {multi
          ? "link: same everywhere · columns: spread"
          : "columns: one frame per value"}
      </Text>
    </Stack>
  );
}

/**
 * One option: its name, its values (chips for a choice, swatches for a
 * color), and the row's link and spread.
 */
function OptionRow({
  frame,
  option,
  value,
  shownValue,
  onPick,
  onClose,
}: {
  frame: PrototypeFrame;
  option: PrototypeOption;
  /** The picked value (or the default). */
  value: string;
  /** What is on screen: `value`, or a color being dragged. */
  shownValue: string;
  onPick: (value: string) => void;
  onClose: () => void;
}): ReactElement {
  const { canvas, dispatch } = usePrototypeDetail();
  const multi = prototypeFrames(canvas.frames).length > 1;
  const linked = canvas.linked.has(option.name);
  const spread = canvas.spread === option.name;
  // Under a group the row drops the group's prefix ("Code block" under
  // "Mist"); its accessible name stays the whole name, unique in the popover.
  const label = humanizeToken(option.name);
  const shownLabel = optionLabel(option);
  // The chip already on screen writes nothing: frame A's write would reach
  // every surface showing this prototype.
  const pick = (v: string) => {
    if (v !== value) onPick(v);
  };

  return (
    <Stack gap="xs">
      <Stack direction="row" gap="sm" align="center">
        <Text
          variant="caption"
          tone="muted"
          className={cn(rigidClass(), "w-20")}
        >
          {shownLabel}
        </Text>
        <Fill>
          {option.kind === "choice" ? (
            <Cluster gap="xs" role="radiogroup" aria-label={label}>
              {option.values.map((v) => (
                <ToggleChip
                  key={v}
                  role="radio"
                  aria-checked={v === value}
                  active={v === value}
                  onClick={() => pick(v)}
                >
                  {humanizeToken(v)}
                </ToggleChip>
              ))}
            </Cluster>
          ) : (
            <ColorValues
              frame={frame}
              option={option}
              label={label}
              value={value}
              shownValue={shownValue}
              onPick={pick}
            />
          )}
        </Fill>
        <Stack direction="row" gap="none" className={rigidClass()}>
          {multi ? (
            <IconButton
              icon={linkIcon}
              label={
                linked
                  ? "Same in every frame — click to unlink"
                  : "Keep the same in every frame"
              }
              aria-pressed={linked}
              className={linked ? "bg-primary/15 text-primary-text" : undefined}
              onClick={() =>
                dispatch({ type: "toggleLink", id: frame.id, option })
              }
            />
          ) : null}
          {spread || spreadValues(option, value).length > 1 ? (
            <IconButton
              icon={viewColumnIcon}
              label={
                spread
                  ? `Gather back into one frame`
                  : option.kind === "color"
                    ? `One frame per suggested ${label.toLowerCase()}`
                    : `One frame per ${label.toLowerCase()}`
              }
              aria-pressed={spread}
              className={spread ? "bg-primary/15 text-primary-text" : undefined}
              onClick={() => {
                onClose();
                dispatch({ type: "toggleSpread", id: frame.id, option });
              }}
            />
          ) : null}
        </Stack>
      </Stack>
    </Stack>
  );
}

/**
 * A color option's values: one swatch per suggestion (a radio, named in its
 * tooltip) and a trailing custom swatch — the color on screen, ringed when it
 * is none of the suggestions — that opens the picker in a popover beside it.
 */
function ColorValues({
  frame,
  option,
  label,
  value,
  shownValue,
  onPick,
}: {
  frame: PrototypeFrame;
  option: ColorOption;
  label: string;
  value: string;
  shownValue: string;
  onPick: (value: string) => void;
}): ReactElement {
  const shownColor = pickedColor(option, { [option.name]: shownValue });
  const custom = !option.suggestions.some((s) => s.name === shownValue);
  return (
    <Cluster gap="xs">
      {option.suggestions.length > 0 ? (
        <Cluster gap="xs" role="radiogroup" aria-label={label}>
          {option.suggestions.map((s) => (
            <WithTooltip
              key={s.name}
              content={`${humanizeToken(s.name)} · ${s.color}`}
            >
              <button
                type="button"
                role="radio"
                aria-checked={s.name === shownValue}
                aria-label={humanizeToken(s.name)}
                onClick={() => onPick(s.name)}
                className={cn(
                  swatchClass,
                  s.name === shownValue && selectedSwatchClass,
                )}
                style={{ background: s.color }}
              />
            </WithTooltip>
          ))}
        </Cluster>
      ) : null}
      <ColorOptionPopover
        frame={frame}
        option={option}
        label={label}
        value={value}
        shownValue={shownValue}
        trigger={
          <button
            type="button"
            aria-label={`Pick any ${label.toLowerCase()} color`}
            title={custom ? `Custom · ${shownColor}` : undefined}
            className={cn(swatchClass, custom && selectedSwatchClass)}
            style={{ background: shownColor }}
          >
            <Center as="span" className="size-full">
              <Icon
                icon={paletteIcon}
                className="size-3 text-white mix-blend-difference"
              />
            </Center>
          </button>
        }
      />
    </Cluster>
  );
}

/**
 * A color row's picker, in its own popover opening above the row's custom
 * swatch it was opened from (a fresh picker per open, so its "before" swatch is the color this
 * open started from). Closing it mid-drag drops the preview. Every move previews (`previewPick`) —
 * the frame repaints, nothing is written — and the drag's end, a field commit
 * or a swatch picks (`setPick`, one write). A color that lands on a
 * suggestion is stored as that suggestion's name.
 */
function ColorOptionPopover({
  frame,
  option,
  label,
  value,
  shownValue,
  trigger,
}: {
  frame: PrototypeFrame;
  option: ColorOption;
  label: string;
  value: string;
  shownValue: string;
  trigger: ReactElement;
}): ReactElement {
  const { canvas, dispatch } = usePrototypeDetail();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  // The picker's own last emission (an oklch string), handed back as its
  // `value` while it still names the color on screen: a hex round-trip would
  // quantize the thumb under the pointer.
  const [emitted, setEmitted] = useState<string | null>(null);
  const shownColor = pickedColor(option, { [option.name]: shownValue });
  const pickerValue =
    emitted !== null && hexOf(emitted) === shownColor ? emitted : shownColor;
  const valueOf = (oklch: string) => colorPickValue(option, hexOf(oklch));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setSession((n) => n + 1);
          setEmitted(null);
        } else if (canvas.preview?.id === frame.id) {
          dispatch({ type: "clearPreview" });
        }
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        width="content"
        padding="none"
      >
        <ColorPicker
          key={session}
          title={label}
          value={pickerValue}
          defaultValue={option.default}
          swatches={option.suggestions.map((s) => ({
            name: humanizeToken(s.name),
            color: s.color,
          }))}
          onChange={(oklch) => {
            setEmitted(oklch);
            dispatch({
              type: "previewPick",
              id: frame.id,
              option: option.name,
              value: valueOf(oklch),
            });
          }}
          onCommit={(oklch) => {
            setEmitted(oklch);
            const next = valueOf(oklch);
            // Back on the value already picked: nothing to write.
            if (next === value) dispatch({ type: "clearPreview" });
            else {
              dispatch({
                type: "setPick",
                id: frame.id,
                option: option.name,
                value: next,
              });
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The picker's emission as the `#rrggbb` a color option stores. Throws on anything else. */
function hexOf(css: string): string {
  const parsed = parseOptionColor(css);
  if (!parsed.ok) throw new Error(`color picker emitted ${parsed.reason}`);
  return parsed.hex;
}

/** A color dot in the pill. */
function ColorDot({ color }: { color: string }): ReactElement {
  return (
    <span
      aria-hidden
      className={cn("size-3 rounded-full ring-1 ring-border", rigidClass())}
      style={{ background: color }}
    />
  );
}

const swatchClass = cn(
  "size-5 rounded-full border border-border transition-transform",
  rigidClass(),
);
const selectedSwatchClass =
  "scale-110 ring-2 ring-ring ring-offset-1 ring-offset-background";
