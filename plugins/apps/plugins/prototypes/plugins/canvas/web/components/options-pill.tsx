import { useState, type ReactElement, type ReactNode } from "react";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { subThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
  useCollapsibleContext,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  Button,
  ControlSizeProvider,
  Separator,
  cn,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
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
import { frameChipsTheme, optionRowsTheme } from "../internal/sub-themes";
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
const chevronDownIcon = symbol("keyboard-arrow-down");

/** Which frame's options a popover edits, and how it is named in its header. */
interface OptionsTarget {
  frame: PrototypeFrame;
  meta: PrototypeMeta;
}

/**
 * A frame header's options chip (the mockup's `.vchip`): the sliders glyph,
 * the frame's name ("Empty · Dark"), a dimmed mono `+N` for the options the
 * name leaves out, and a chevron — opening the Options popover under it.
 * Narrow (a frame under 440px) it drops `+N` and the chevron.
 *
 * Renders nothing for a document with no options: the frame box then holds
 * the version stepper alone. Its 22px look is the frame box's
 * (`frameChipsTheme`).
 */
export function OptionsChip({
  frame,
  meta,
  name,
  named,
  narrow,
}: OptionsTarget & {
  /** The frame's name ("Empty · Dark"). */
  name: string;
  /** How many options `name` spells; `+N` counts the rest. */
  named: number;
  narrow: boolean;
}): ReactElement | null {
  const options = documentOptions(meta, frame.version);
  if (options.length === 0) return null;
  const rest = options.length - named;
  return (
    <Theme name={subThemeScope(frameChipsTheme)} surface="none">
      <ControlSizeProvider size="sm">
        <OptionsPopover
          frame={frame}
          meta={meta}
          title={`Options · ${name}`}
          trigger={
            <Button
              variant="ghost"
              aria-label="Prototype options"
              className="text-muted-foreground"
            >
              <Icon icon={tuneIcon} className="text-faint-foreground" />
              <Text variant="group">{name}</Text>
              {!narrow && rest > 0 ? (
                <span className="font-mono text-2xs text-faint-foreground">
                  +{String(rest)}
                </span>
              ) : null}
              {narrow ? null : (
                <Icon
                  icon={chevronDownIcon}
                  className="text-faint-foreground"
                />
              )}
            </Button>
          }
        />
      </ControlSizeProvider>
    </Theme>
  );
}

/**
 * The Options popover (the mockup's `.pop.options`), opened from `trigger`:
 * a header naming the frame, then one row per declared option — value pills
 * for a choice, suggestion swatches plus a custom swatch (which opens a color
 * picker in its own popover beside it) for a color — plus per row a link (keep
 * it the same in every frame) and a spread (one frame per value, or per
 * suggestion), at .4 until the row is hovered. Options the page declares under
 * a group (`<meta name="prototype-option-group">`) sit in one collapsible
 * section per group, which names its picks when folded.
 *
 * A color drag previews (`previewPick`: the frame repaints every move, nothing
 * is written) and its end commits (`setPick`: one write). The swatches show
 * the preview too, so they move with the frame.
 *
 * App DOM, never inside the prototype's page — that is what keeps switchers
 * out of the designs. It always edits ITS frame, so nothing needs
 * disambiguating. The frame's picks are always known here: the canvas does not
 * exist until they load.
 */
function OptionsPopover({
  frame,
  meta,
  title,
  trigger,
}: OptionsTarget & {
  title: string;
  trigger: ReactElement;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const { canvas, dispatch } = usePrototypeDetail();
  const options = documentOptions(meta, frame.version);
  const picks = useFramePicks(frame, meta);
  const shown = shownPicks(canvas, frame, options, picks);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) return;
        // A drag cut short by the popover closing is dropped, not picked.
        if (canvas.preview?.id === frame.id) dispatch({ type: "clearPreview" });
      }}
    >
      <WithTooltip content="Options">
        <PopoverTrigger render={trigger} />
      </WithTooltip>
      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={8}
        width="builder"
      >
        <ControlSizeProvider size="sm">
          <Theme name={subThemeScope(optionRowsTheme)} surface="none">
            <Stack gap="none" role="group" aria-label="Options">
              <PopoverHeading
                title={title}
                onReset={
                  Object.keys(picks).length > 0
                    ? () => dispatch({ type: "resetPicks", id: frame.id })
                    : null
                }
              />
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
                  <Stack key={key} gap="none">
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
            </Stack>
          </Theme>
        </ControlSizeProvider>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The picks a frame's popover shows: its resolved picks, with a color being
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

/** A value as a folded group header writes it: a token humanized, a custom color as its hex. */
function valueLabel(value: string): string {
  return value.startsWith("#") ? value : humanizeToken(value);
}

/** The popover's header row (`.ph`): `Options · <frame>`, and Reset when picked. */
function PopoverHeading({
  title,
  onReset,
}: {
  title: string;
  onReset: (() => void) | null;
}): ReactElement {
  return (
    <Line className="gap-sm p-row">
      <Fill>
        <Text as="h5" variant="group" tone="muted">
          {title}
        </Text>
      </Fill>
      {onReset !== null ? (
        <ControlSizeProvider size="xs">
          <Button
            variant="ghost"
            className="text-faint-foreground"
            onClick={onReset}
          >
            Reset to defaults
          </Button>
        </ControlSizeProvider>
      ) : null}
    </Line>
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
      <CollapsibleTrigger className="w-full gap-xs rounded-panel-row p-row text-muted-foreground hover:text-foreground">
        <Text as="span" variant="group" className={rigidClass()}>
          {label}
        </Text>
        <GroupHeaderTail summary={summary} />
        <CollapsibleChevron className="size-3 text-faint-foreground" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="none">{children}</Stack>
      </CollapsibleContent>
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

/**
 * One option (`.orow`): its name (84px, muted), its values (pills for a
 * choice, swatches for a color), and the row's link and spread — dimmed to .4
 * until the row is hovered, in the accent while on.
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
    // A row of the popover: its inset, hover and corners are `Row`'s (the
    // option-rows sub-theme's 6px 10px; a panel row's radius). Not activating —
    // a plain container, so it holds the pills.
    <Row>
      {/* 86px + the 8px gap = the mockup's 84px label track and 10px gap. */}
      <Text tone="muted" className={cn(rigidClass(), "w-21.5")}>
        {shownLabel}
      </Text>
      <ControlSizeProvider size="xs">
        <Fill>
          {option.kind === "choice" ? (
            <Cluster gap="xs" role="radiogroup" aria-label={label}>
              {option.values.map((v) => (
                <Button
                  key={v}
                  variant="ghost"
                  role="radio"
                  aria-checked={v === value}
                  onClick={() => pick(v)}
                  className={cn(
                    "text-muted-foreground",
                    v === value &&
                      "border-primary/45 bg-primary/14 text-foreground hover:bg-primary/14",
                  )}
                >
                  {humanizeToken(v)}
                </Button>
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
              className={rowActionClass(linked)}
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
              className={rowActionClass(spread)}
              onClick={() => {
                onClose();
                dispatch({ type: "toggleSpread", id: frame.id, option });
              }}
            />
          ) : null}
        </Stack>
      </ControlSizeProvider>
    </Row>
  );
}

/** A row's link / spread: .4 until its row is hovered (or it is on, in the accent). */
function rowActionClass(on: boolean): string {
  return on
    ? "text-primary-text"
    : "opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100";
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

const swatchClass = cn(
  "size-5 rounded-full border border-border transition-transform",
  rigidClass(),
);
const selectedSwatchClass =
  "scale-110 ring-2 ring-ring ring-offset-1 ring-offset-background";
