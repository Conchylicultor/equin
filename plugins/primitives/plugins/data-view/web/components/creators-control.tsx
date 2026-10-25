import { type ComponentProps, type ReactNode, useState } from "react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  textStepFor,
  useControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  rolePickClass,
  rolePickScope,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { DATA_VIEW_PICKS } from "@plugins/ui/plugins/tokens/plugins/data-view/core";
import { dataPart, type CreateOption, type ToolbarPartForms } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

/**
 * The narrow stage, as the toolbar band publishes it: `--dv-band-narrow: yes`
 * while the band measures itself narrow (`NARROW_BREAKPOINT`), set on the
 * band's box, so every create button in the band reads it — the host's own
 * and a surface's (a `CreateButton` inside a launch popover) alike. With the
 * theme's `narrowCreateLabel: "hide"` the words go (`show` by default, so
 * inert unless a theme opts in) and the padding takes `createPadNarrow`.
 */
const NARROW_HIDE_CLASS =
  "[@container_style(--narrow-create-label:hide)_and_style(--dv-band-narrow:yes)]:hidden";
const NARROW_PAD_CLASS =
  "[@container_style(--narrow-create-label:hide)_and_style(--dv-band-narrow:yes)]:px-create-narrow";

/**
 * A labelled create button's words, in the type the theme picks for them
 * (`DATA_VIEW_PICKS.create`; default the control role the `Button` already
 * sets, at its density's rung — so a theme that says nothing changes nothing).
 * Spelled with `rolePickScope` / `rolePickClass` rather than `<Text pick>`: a
 * `Text` in the toolbar's single-line row would add a native `title` and the
 * truncating leaf box to the button's label.
 */
function CreateLabel(props: { children: ReactNode }): ReactNode {
  const compact = textStepFor(useControlSize()) === 1;
  const pick = DATA_VIEW_PICKS.create;
  return (
    <span
      className={cn("contents", NARROW_HIDE_CLASS)}
      style={rolePickScope(pick)}
    >
      <span className={rolePickClass(pick.fallback, compact)}>
        {props.children}
      </span>
    </span>
  );
}

/**
 * THE labelled create button — the one a DataView's toolbar draws for its
 * creators (the `dv.create` part; its inline padding `createPadStart/End` —
 * `px-create`, unset = the `sm` button's own `px-control-sm` — and corners
 * `createRadius`; its words in the `create` pick; on a narrow band, the
 * theme's `narrowCreateLabel`), exported so a surface whose create affordance
 * is its own panel (a launch popover) draws the same button as that panel's
 * trigger. Every prop but the words lands on the `Button` (a popover
 * trigger's `render` target spreads onto it). `icon` defaults to `+`
 * (`false` draws none). The words are also its name (`aria-label`), so
 * dropping them on a narrow band keeps it named.
 */
export function CreateButton({
  label,
  icon,
  ...rest
}: {
  label: string;
  icon?: ReactNode;
} & Omit<ComponentProps<typeof Button>, "children">): ReactNode {
  return (
    <Button
      aria-label={label}
      {...dataPart("dv.create")}
      {...rest}
      className={cn(
        "px-create",
        NARROW_PAD_CLASS,
        "[@container_not_style(--create-radius:initial)]:rounded-create",
        rest.className,
      )}
    >
      {icon ?? <Icon icon={addIcon} />}
      <CreateLabel>{label}</CreateLabel>
    </Button>
  );
}

/**
 * Host-internal toolbar render of `DataViewProps.creators`. NOT exported from
 * the web barrel — consumers declare `creators` and the host renders this.
 *
 * - `0` (or undefined) → nothing.
 * - `1` → a labelled `Button`, or (when `compact`) a `+` `IconButton` with the
 *   label as its tooltip — folding it below a narrow toolbar like every sibling.
 * - `N` → a `+` `IconButton` opening a dropdown menu of icon + label (+ muted
 *   description) items — or, given `createLabel` (`DataViewProps.createLabel`)
 *   and neither `compact` nor `round`, a labelled `Button` (`+` and the label)
 *   opening the same menu.
 *
 * Every create trigger is stamped `data-part="dv.create"`; a labelled one's
 * words take the type the theme picks (`DATA_VIEW_PICKS.create`).
 *
 * Owns a single shared in-flight `busy` flag: each `run` awaits `onSelect` in a
 * `try/finally`, disabling the control while pending — a consistent busy
 * affordance for every consumer.
 */
export function CreatorsControl({
  creators,
  createLabel,
  compact = false,
  form = "labelled",
}: {
  creators?: CreateOption[];
  /** `DataViewProps.createLabel`: N creators draw a labelled trigger. */
  createLabel?: string | undefined;
  compact?: boolean;
  /**
   * The wide form — the arrangement's `forms.creators`. `round` draws the `+`
   * as a filled circle (one creator's label moves to its tooltip). Ignored when
   * `compact`, which is the fold's own form.
   */
  form?: ToolbarPartForms["creators"];
}): ReactNode {
  const [busy, setBusy] = useState(false);

  if (!creators || creators.length === 0) return null;
  const round = !compact && form === "round";
  // Spread only in the round form, so the other forms' props stay exactly what
  // they were (a ghost `+`).
  const roundProps = round
    ? ({ variant: "default", shape: "pill" } as const)
    : {};

  const run = async (c: CreateOption): Promise<void> => {
    setBusy(true);
    try {
      await c.onSelect();
    } finally {
      setBusy(false);
    }
  };

  if (creators.length === 1) {
    const c = creators[0]!;
    // Compact: fold to an `MdAdd` IconButton (label → tooltip), matching the
    // N-creator trigger — `IconButton` takes an icon *component*, so the
    // creator's own `icon` ReactNode is not used here.
    if (compact || round) {
      return (
        <IconButton
          icon={addIcon}
          label={c.label}
          disabled={busy}
          onClick={() => run(c)}
          {...roundProps}
          {...dataPart("dv.create")}
        />
      );
    }
    return (
      <CreateButton
        label={c.label}
        icon={c.icon ?? false}
        disabled={busy}
        onClick={() => run(c)}
      />
    );
  }

  // N creators: a labelled trigger when the surface names one (and the form
  // has room for words), else today's `+`.
  const labelled = createLabel !== undefined && !compact && !round;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          labelled ? (
            <CreateButton label={createLabel} disabled={busy} />
          ) : (
            <IconButton
              icon={addIcon}
              label={createLabel ?? "Create"}
              disabled={busy}
              {...roundProps}
              {...dataPart("dv.create")}
            />
          )
        }
      />
      <DropdownMenuContent align="end">
        {creators.map((c) => (
          <DropdownMenuItem
            key={c.id}
            disabled={busy}
            onClick={() => void run(c)}
          >
            {c.icon}
            <Stack gap="none">
              <Text variant="label">{c.label}</Text>
              {c.description ? (
                <Text variant="caption" tone="muted">
                  {c.description}
                </Text>
              ) : null}
            </Stack>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A hosted surface's create affordance (`HostedToolbarParts.creators`): the
 * compact form — a hosted frame is small chrome, like the band's fold — or
 * `null` when the surface declares no creator, so the frame can tell "nothing
 * to place" from a node that renders nothing.
 */
export function hostedCreators(creators?: CreateOption[]): ReactNode {
  return creators && creators.length > 0 ? (
    <CreatorsControl creators={creators} compact />
  ) : null;
}
