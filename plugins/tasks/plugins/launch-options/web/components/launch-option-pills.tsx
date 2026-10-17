import { useMemo } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { OverlayBoundary } from "@plugins/primitives/plugins/overlay/plugins/overlay-boundary/web";
import { PickerPill } from "@plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web";
import { TooltipDoc } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useConfigLink } from "@plugins/config_v2/plugins/config-link/web";
import { runActivation } from "@plugins/primitives/plugins/link-gesture/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { TaskLaunch } from "../slots";
import { launchOptionValue, type LaunchOptionValues } from "../internal/values";

const settingsIcon = symbol("settings");

/** One registered launch option, as the slot hands it over. */
type OptionItem = ReturnType<typeof TaskLaunch.Option.useContributions>[number];

/** Which half of the composer bar a group is drawn on. */
type BarSide = "start" | "end";

/**
 * One pill's worth of options: either several options that declared the same
 * `cluster` (they fuse into ONE pill) or a single option on its own.
 */
interface PillGroup {
  key: string;
  side: BarSide;
  members: OptionItem[];
}

export interface LaunchOptionPillsProps {
  values: LaunchOptionValues;
  onChange: (next: LaunchOptionValues) => void;
  disabled: boolean;
  /** Which half of the bar to draw — the leading one, or the trailing one. */
  side: BarSide;
  /**
   * How a pill reads while its option is on its default — the word, or the
   * bare icon (a crowded bar). See `PickerPill`'s `unset`.
   */
  unset?: "placeholder" | "icon";
  /**
   * Ids of options the HOST decides for this launch (e.g. a flow that always
   * runs in its own workspace): their pills are not drawn, so the user is never
   * offered a choice the host will not honour.
   */
  omit?: readonly string[];
}

/**
 * The registered launch options, as pills on a composer bar — the task-draft
 * card's and the launch-agent popover's alike. Controlled: the host owns the
 * values, as it does for every launch control.
 *
 * It names no option. Everything it draws comes from what each option
 * *declared*: its glyph, its cluster, which end of the bar it sits on, and the
 * two holes it paints (the trigger's text and the menu's rows). So a new launch
 * option lands on this bar with no edit here — and an option that declared no
 * pill at all still appears, as its own control, inline.
 *
 * Rendered twice per bar, once per side, because the two halves of the bar are
 * separate holes in the field: the leading one sits beside the prose controls
 * and the trailing one is flush right.
 */
export function LaunchOptionPills({
  values,
  onChange,
  disabled,
  side,
  unset,
  omit,
}: LaunchOptionPillsProps) {
  const options = TaskLaunch.Option.useContributions();
  const groups = useMemo(
    () =>
      groupOptions(
        omit ? options.filter((o) => !omit.includes(o.id)) : options,
      ),
    [options, omit],
  );
  return (
    <>
      {groups
        .filter((group) => group.side === side)
        .map((group) => (
          <LaunchOptionGroup
            key={group.key}
            group={group}
            values={values}
            onChange={onChange}
            disabled={disabled}
            unset={unset}
          />
        ))}
    </>
  );
}

/**
 * Fold the registered options into the pills the bar draws, in registry order.
 * Options that declared the same `cluster` join one group; anything else is a
 * group of one — including an option with no pill at all, which then renders as
 * its own control.
 */
function groupOptions(options: readonly OptionItem[]): PillGroup[] {
  const groups: PillGroup[] = [];
  const byCluster = new Map<string, PillGroup>();
  for (const option of options) {
    const side = option.pill?.side ?? "start";
    const cluster = option.pill?.cluster;
    if (cluster === undefined) {
      groups.push({ key: `option:${option.id}`, side, members: [option] });
      continue;
    }
    const open = byCluster.get(cluster);
    if (open) {
      open.members.push(option);
      continue;
    }
    const group: PillGroup = {
      key: `cluster:${cluster}`,
      side,
      members: [option],
    };
    byCluster.set(cluster, group);
    groups.push(group);
  }
  return groups;
}

function LaunchOptionGroup({
  group,
  values,
  onChange,
  disabled,
  unset,
}: {
  group: PillGroup;
  values: LaunchOptionValues;
  onChange: (next: LaunchOptionValues) => void;
  disabled: boolean;
  unset: "placeholder" | "icon" | undefined;
}) {
  const configLink = useConfigLink();
  const members = group.members;
  const lead = members[0]!;
  const pill = lead.pill;
  const set = (option: OptionItem) => (next: unknown) =>
    onChange({ ...values, [option.id]: next });

  if (!pill) {
    // No pill declared: the option still belongs on the bar, so it draws itself
    // as the same control the task detail's Prompt card renders. A group with no
    // pill always has exactly one member — a cluster is declared *by* a pill.
    //
    // `renderIsolated` rather than the sealed component by hand: this host picks
    // and regroups contributions itself, which `.Render` cannot express, and it
    // is the one escape that still puts the contribution through the slot's
    // middleware chain — so a crash here is contained like any other.
    return renderIsolated(TaskLaunch.Option, lead as unknown as Contribution, {
      value: launchOptionValue(values, lead),
      onChange: set(lead),
      disabled,
    });
  }

  const shown = shownValues(members, values);

  return (
    <PickerPill
      icon={pill.icon}
      placeholder={lead.label}
      unset={unset}
      highlight={isChanged(members, values)}
      disabled={disabled}
      tooltip={<PillTooltip members={members} />}
    >
      {shown.map((entry, i) => {
        const option = entry.option;
        const Value = option.pill!.Value;
        return (
          <PickerPill.Value key={`value:${option.id}`} muted={i > 0}>
            {entry.set ? (
              /* Each contributed half gets its own boundary: rendered directly
                 (the pill fuses them into one trigger and one menu), they would
                 otherwise sit outside the middleware chain `.Render` gives a
                 contribution, and one bad option would blank the whole field. */
              <PluginErrorBoundary
                slot={TaskLaunch.Option.id}
                label={option.label}
              >
                <Value value={entry.value} />
              </PluginErrorBoundary>
            ) : (
              /* The unset state is the host's to paint — a plain word the
                 option lent it, so there is no contributed code to contain. */
              entry.label
            )}
          </PickerPill.Value>
        );
      })}
      {members.map((option) => {
        const { MenuGroup, configure } = option.pill!;
        return (
          <PickerPill.Group
            key={`group:${option.id}`}
            title={option.label}
            action={
              configure && {
                icon: settingsIcon,
                label: `Configure: ${option.label}`,
                // A menu-section action: no gestures to read, so it follows
                // the link the way a plain click does.
                onAction: () => runActivation(configLink(configure)),
              }
            }
          >
            {/* The menu half is overlay content, so it takes the boundary
                built for that. The panel already carries one around the whole
                menu; one per option makes THIS the nearest, so a bad option
                loses its own section instead of every section. */}
            <OverlayBoundary>
              <MenuGroup
                value={launchOptionValue(values, option)}
                onChange={set(option)}
                disabled={disabled}
              />
            </OverlayBoundary>
          </PickerPill.Group>
        );
      })}
    </PickerPill>
  );
}

/**
 * The pill's hover documentation, from what each member declared. A solo pill
 * is its option's label and description; a fused pill names every member and
 * gives each its own line, since one trigger configures all of them.
 */
function PillTooltip({ members }: { members: OptionItem[] }) {
  if (members.length === 1) {
    const option = members[0]!;
    return <TooltipDoc title={option.label}>{option.description}</TooltipDoc>;
  }
  return (
    <TooltipDoc title={members.map((option) => option.label).join(" · ")}>
      <Stack gap="2xs">
        {members.map((option) => (
          <span key={option.id}>
            <strong className="font-medium">{option.label}:</strong>{" "}
            {option.description}
          </span>
        ))}
      </Stack>
    </TooltipDoc>
  );
}

/** One slot of a pill's trigger: a value to render, or the word for its absence. */
type ShownValue =
  | { option: OptionItem; set: true; value: NonNullable<unknown> }
  | { option: OptionItem; set: false; label: string };

/**
 * What the trigger actually prints, left to right.
 *
 * A **fused** pill shows every member, because a member that vanished when
 * unset is a control the user cannot see and so cannot find: an unset one takes
 * the word the option lent for its own absence (`unsetLabel`), or is dropped
 * only if it lent none.
 *
 * A **solo** pill keeps the older rule — its one unset value shows nothing, so
 * the pill falls back to its placeholder, which is the right reading for a pill
 * that holds one thing and is holding nothing.
 *
 * Either way the muting downstream reads "first value strong, the rest dim"
 * over what is on screen rather than over what was registered.
 */
function shownValues(
  members: OptionItem[],
  values: LaunchOptionValues,
): ShownValue[] {
  const fused = members.length > 1;
  return members.flatMap((option): ShownValue[] => {
    const value = launchOptionValue(values, option);
    if (value != null) return [{ option, set: true, value }];
    const label = fused ? option.pill?.unsetLabel : undefined;
    return label === undefined ? [] : [{ option, set: false, label }];
  });
}

/**
 * Whether this pill should paint the "you changed something" tint — derived,
 * never declared, so no option can claim to be set while showing its default.
 *
 * A fused pill never tints: with two values under one trigger there is no
 * honest answer to *which* of them the tint would be about.
 *
 * `Object.is` against the option's own `defaultValue` is the whole comparison —
 * a launch value is a JSON scalar (a model id, an effort level, a preprompt id,
 * or `null`). A future structured value would need its `def` to carry a
 * comparator rather than this guessing at one.
 */
function isChanged(members: OptionItem[], values: LaunchOptionValues): boolean {
  if (members.length !== 1) return false;
  const option = members[0]!;
  return !Object.is(launchOptionValue(values, option), option.def.defaultValue);
}
