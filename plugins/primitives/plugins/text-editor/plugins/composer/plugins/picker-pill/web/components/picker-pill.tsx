import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSection,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type MenuRowAction,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { WithTooltip } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import {
  WithHoverCard,
  type HoverCardContent,
} from "@plugins/primitives/plugins/overlay/plugins/hover-card/web";
import { Children, cloneElement, Fragment, isValidElement } from "react";

import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { pillHighlightClass } from "./highlight";

const checkIcon = symbol("check");
const keyboardArrowDownIcon = symbol("keyboard-arrow-down");

export interface PickerPillProps {
  /** Leading glyph, always shown — it is what the pill is recognised by. */
  icon: IconRef;
  /**
   * What the trigger reads while NOTHING is picked, in muted text. Also the
   * accessible name when `ariaLabel` is omitted.
   */
  placeholder: string;
  /**
   * How the trigger reads while nothing is picked: `placeholder` (default) —
   * icon, muted placeholder, chevron — or `icon`: the bare icon alone, for a
   * crowded bar where an unset setting should take no room. The tooltip and
   * accessible name still say what it is.
   */
  unset?: "placeholder" | "icon";
  /**
   * Paint the accent-tinted "this is set" state. One pill, one highlight —
   * a fused pill (several groups) deliberately never tints, because "set"
   * would be ambiguous across its groups.
   */
  highlight?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  /**
   * Hover tooltip on the trigger — what this pill configures, for someone who
   * has not opened it yet (a `TooltipDoc`, typically). Required: a pill reads
   * as a word like "Preprompt" or "Dependency", which names the setting but
   * does not explain it to a new user.
   */
  tooltip: React.ReactNode;
  /** `PickerPill.Value` and `PickerPill.Group` children, in any order. */
  children?: React.ReactNode;
}

export interface PickerPillValueProps {
  /** Dim this value — used for every value after the first. */
  muted?: boolean;
  children: React.ReactNode;
}

export interface PickerPillGroupProps {
  /** Section heading inside the menu. */
  title: string;
  /**
   * A trailing action on the heading — typically a gear to the settings the
   * group's rows come from, so a library-backed picker can be edited from it.
   */
  action?: MenuRowAction;
  children?: React.ReactNode;
}

export interface PickerPillItemProps {
  /** Optional leading glyph for this row. */
  icon?: React.ReactNode;
  /** The current row of its group — draws a check instead of its note. */
  selected?: boolean;
  /** Dim trailing hint ("default", a shortcut, …), shown when not selected. */
  note?: string;
  /**
   * What this row is, in more words than its label — shown in a hover card
   * beside the menu, level with the row, while it is hovered, so a plain menu
   * can still explain its choices. Data, laid out by the card.
   */
  info?: HoverCardContent;
  onSelect: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

export interface PickerPillCheckProps {
  /** Optional leading glyph for this row. */
  icon?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

/**
 * The bar control: a pill reading `icon · value(s) · chevron` that opens one
 * grouped menu.
 *
 * **Several `Group`s in one pill IS the fused control** — the model and the
 * thinking mode read as `✦ Opus 5  Max` under a single trigger, and the menu
 * that opens has one heading per group with a check on each group's current
 * row. Nothing about that is a special case: a pill with one group is the same
 * component with one child.
 *
 * With no `Value` children the trigger shows `placeholder` in muted text — the
 * unset look, which is how "Preprompt" and "Dependency" read before you pick
 * anything.
 *
 * The trigger never wraps and never grows beyond what its own text needs, so a
 * pill on a single-line bar does not move its neighbours when you open it.
 */
export function PickerPill({
  icon,
  placeholder,
  unset = "placeholder",
  highlight,
  disabled,
  ariaLabel,
  tooltip,
  children,
}: PickerPillProps) {
  const { values, groups } = partition(children);
  const bare = values.length === 0 && unset === "icon";

  return (
    <DropdownMenu>
      <WithTooltip content={tooltip}>
        <DropdownMenuTrigger
          render={
            <Button
              shape="pill"
              aspect={bare ? "icon" : "text"}
              variant={highlight ? "frame" : "ghost"}
              disabled={disabled}
              aria-label={ariaLabel ?? placeholder}
              className={cn(highlight && pillHighlightClass)}
            />
          }
        >
          <Icon icon={icon} aria-hidden className="size-3.5" />
          {values.length > 0 ? (
            values.map((value, i) =>
              cloneElement(value, { key: value.key ?? i }),
            )
          ) : bare ? null : (
            <Text variant="control" tone="muted">
              {placeholder}
            </Text>
          )}
          {!bare && (
            <Icon
              icon={keyboardArrowDownIcon}
              className="size-3.5 opacity-70"
            />
          )}
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="start">
        {groups.map((group, i) => (
          <Fragment key={group.key ?? i}>
            {i > 0 && <DropdownMenuSeparator />}
            {group}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One piece of the trigger's text. The first reads at full strength and later
 * ones are `muted`, so a fused pill reads as "Opus 5, thinking Max" rather than
 * as two equal labels.
 */
function PickerPillValue({ muted, children }: PickerPillValueProps) {
  return (
    <Text variant="control" tone={muted ? "muted" : "default"}>
      {children}
    </Text>
  );
}

/** One headed section of the menu. */
function PickerPillGroup({ title, action, children }: PickerPillGroupProps) {
  return (
    <DropdownMenuSection label={title} action={action}>
      {children}
    </DropdownMenuSection>
  );
}

/** One row of a group. */
function PickerPillItem({
  icon,
  selected,
  note,
  info,
  onSelect,
  disabled,
  children,
}: PickerPillItemProps) {
  const row = (
    <DropdownMenuItem disabled={disabled} onClick={onSelect} className="gap-lg">
      {/* The label is the row's one flexible cell, so the check / note below
          sits in its own track flush right instead of floating over it. */}
      <Stack
        as="span"
        direction="row"
        align="center"
        gap="xs"
        className={fillClasses("x")}
      >
        {icon}
        {children}
      </Stack>
      {selected ? (
        <Icon icon={checkIcon} className="size-3.5 opacity-70" aria-hidden />
      ) : note ? (
        <Text variant="caption" tone="muted">
          {note}
        </Text>
      ) : null}
    </DropdownMenuItem>
  );
  if (info == null) return row;
  // The card hangs off a wrapper, not the row: a disabled row takes no pointer
  // events, and its card — often the one place saying WHY it is disabled —
  // must still show. The hover falls through the disabled row to the wrapper.
  return (
    <WithHoverCard card={info} beside="panel">
      <span className="block">{row}</span>
    </WithHoverCard>
  );
}

/**
 * A checkbox row of a group: an independent on/off option rather than one of a
 * group's mutually exclusive picks. Toggling it leaves the menu open, so
 * several checks can be flipped in one visit.
 */
function PickerPillCheck({
  icon,
  checked,
  onCheckedChange,
  disabled,
  children,
}: PickerPillCheckProps) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      closeOnClick={false}
      disabled={disabled}
      className="gap-lg"
    >
      {/* The checkbox item's grid already makes the label its one flexible
          (truncating) cell, with the check in its own track flush right. */}
      {icon}
      {children}
    </DropdownMenuCheckboxItem>
  );
}

type PillChild = React.ReactElement<
  PickerPillValueProps | PickerPillGroupProps
>;

/**
 * Split the declared children into the trigger's values and the menu's groups.
 *
 * Anything that is neither throws rather than vanishing: a stray child in a
 * compound component would otherwise simply not render, which looks exactly
 * like the value being unset.
 */
function partition(children: React.ReactNode): {
  values: PillChild[];
  groups: PillChild[];
} {
  const values: PillChild[] = [];
  const groups: PillChild[] = [];
  walk(children, (child) => {
    if (child.type === PickerPillValue) values.push(child);
    else if (child.type === PickerPillGroup) groups.push(child);
    else
      throw new Error(
        "PickerPill accepts only <PickerPill.Value> and <PickerPill.Group> children.",
      );
  });
  return { values, groups };
}

/** Visit every element child, descending through fragments. */
function walk(node: React.ReactNode, visit: (child: PillChild) => void): void {
  Children.forEach(node, (child) => {
    if (child == null || typeof child === "boolean") return;
    if (isValidElement(child) && child.type === Fragment) {
      walk((child.props as { children?: React.ReactNode }).children, visit);
      return;
    }
    if (!isValidElement(child))
      throw new Error(
        "PickerPill accepts only <PickerPill.Value> and <PickerPill.Group> children.",
      );
    visit(child as PillChild);
  });
}

PickerPill.Value = PickerPillValue;
PickerPill.Group = PickerPillGroup;
PickerPill.Item = PickerPillItem;
PickerPill.Check = PickerPillCheck;
