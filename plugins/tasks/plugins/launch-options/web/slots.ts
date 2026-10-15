import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { LaunchOptionDef } from "../core";
import { defineSlotFacade } from "@plugins/framework/plugins/web-sdk/core";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/**
 * What every launch control receives. Controlled on purpose: the HOST owns
 * storage — the task detail writes the task's row, the draft popover writes a
 * card's local draft — so the same control serves a task that exists and one
 * that does not exist yet.
 */
export interface LaunchControlProps<V> {
  value: V;
  onChange: (next: V) => void;
  disabled?: boolean;
}

/**
 * A control bound to an existing task's persisted value, as a resource result.
 * While the value is still loading (or its read failed) the binding carries NO
 * value: the host shows a loading state — or the failure, with Retry — in the
 * control's place, so a picker can never show (and let you click) a stand-in
 * like "Off" before the task's real value is known.
 */
export type LaunchBinding<V> = ResourceResult<{
  value: V;
  onChange: (next: V) => void;
  /**
   * Why the task's current state makes this option unchangeable, in a
   * sentence. Present ⇒ the host renders the control disabled with this as
   * its tooltip — so a pick the server would refuse (or silently drop) is
   * never offered, and the user is told why.
   */
  disabledReason?: string;
}>;

/**
 * How an option draws itself on a composer bar — as a pill, instead of as the
 * labelled row `component` paints in the task detail's Prompt card.
 *
 * Optional: an option that declares no `pill` still appears on a bar, as its
 * `component`, so adding a launch option never requires editing a host.
 *
 * Nothing new has to be kept in sync with the option's identity: the menu
 * heading and the collapsed placeholder are both the option's existing
 * {@link TaskLaunchOption.label}, and highlighting is **derived by the host**,
 * not declared here — a solo pill tints when its value differs from
 * `def.defaultValue`, and a fused pill never tints.
 *
 * Components rather than an items list on purpose: the host renders one pill
 * per cluster, so a data-shaped descriptor would mean calling each member's
 * hook inside a `.map()` — a rules-of-hooks error. A component per option is
 * one hook scope each, and it keeps a value's own rendering (preprompt's
 * per-row glyph) inside the plugin that owns it.
 *
 * Both components paint the INSIDE of the pill's two holes — the trigger's text
 * and the menu's rows. The pill itself, the headed section around the rows, the
 * muting of a fused pill's later values and the unset state all belong to the
 * host, so an option cannot title its own section differently from its `label`,
 * and the host is the one place the unset state is decided — an option only
 * lends it a word (`unsetLabel`).
 */
export interface LaunchOptionPill<V> {
  /** Leading glyph on the pill's trigger. */
  icon: IconRef;
  /**
   * This option's current value as pill text.
   *
   * **`null` is the unset state, and the host owns it**: it never renders this
   * for an unset value, which is why the value handed in is non-nullable.
   * "Renders nothing when unset" is therefore one rule in one place rather than
   * a convention each option re-implements — and an option that tried to would
   * not type-check. What the host paints instead is
   * {@link LaunchOptionPill.unsetLabel} / the pill's placeholder.
   */
  Value: ComponentType<{ value: NonNullable<V> }>;
  /**
   * What a FUSED pill prints for this option while its value is unset — "Auto"
   * for a thinking mode, "Off" for auto-start.
   *
   * It exists because a fused pill shows **every** member: two options behind
   * one trigger, and the one that is unset simply vanishing, is a control the
   * user cannot see and therefore cannot find. So the trigger names the unset
   * state rather than dropping it, muted like any other non-leading value.
   *
   * A **solo** pill ignores this and falls back to the shared placeholder (the
   * option's own `label`), which is what a one-value pill should read as while
   * it holds nothing. An option in a cluster that omits it shows nothing —
   * same self-describing absence as `useTaskBinding`.
   *
   * A plain string, not a component: this is the host's rendering of a state
   * the host owns, so it takes the WORD from the option and nothing else.
   */
  unsetLabel?: string;
  /**
   * This option's rows inside the menu — bare `PickerPill.Item`s. The host
   * wraps them in the headed section, titled with the option's `label`.
   */
  MenuGroup: ComponentType<LaunchControlProps<V>>;
  /**
   * The config the menu's rows come from (a library such as the preprompts),
   * if any. The host then puts a gear on this option's menu heading that opens
   * its settings, so the choices can be edited from where they are picked —
   * the pill's twin of `ConfigSelectContent` on a select.
   */
  configure?: ConfigDescriptor;
  /** Options sharing a cluster fuse into ONE pill, in registry order. */
  cluster?: string;
  /** Which end of the bar. Defaults to "start". */
  side?: "start" | "end";
}

/**
 * One launch option: a labelled control that configures HOW the agent launches
 * (which model auto-starts it, which preprompt is prepended, which thinking
 * mode it runs at). Each host owns its own chrome — the detail card paints a
 * label column, the draft card paints an inline chip — so a contribution is
 * only its control plus the value contract behind it.
 */
export interface TaskLaunchOption<V> {
  /** Row label in the detail card; chip label in the draft card. */
  label: string;
  /**
   * What this option does, in a sentence — the hover tooltip on its pill and
   * on its label in the detail card. Required: "Preprompt" or "Auto-start"
   * names the setting but does not tell a new user what changing it does.
   */
  description: string;
  /** The shared value contract (see `defineLaunchOption`). */
  def: LaunchOptionDef<V>;
  /** The control itself. Controlled — see {@link LaunchControlProps}. */
  component: ComponentType<LaunchControlProps<V>>;
  /**
   * How this option draws on a composer bar. Omit it and the bar renders
   * `component` inline instead. See {@link LaunchOptionPill}.
   */
  pill?: LaunchOptionPill<V>;
  /**
   * Binds the control to an EXISTING task's storage. Omit it and the option is
   * draft-only — self-describing, so there is no `hosts: [...]` knob to keep in
   * sync with what the plugin actually implements.
   */
  useTaskBinding?: Hook<(taskId: string) => LaunchBinding<V>>;
  /** Short value description folded into the post-submit toast. */
  summarize?: (value: V) => string | null;
}

/**
 * The erased entry the slot stores. A render slot carries ONE contribution
 * type, so `V` collapses to `unknown` here; `TaskLaunch.Option` re-introduces it
 * at the call site, which is the only place drift could happen.
 */
export type LaunchOptionEntry = TaskLaunchOption<unknown> & { id: string };

/**
 * What a NON-rendering consumer needs off an option — the draft's value read,
 * the submit strip, the toast. Deliberately excludes `component`, which
 * `useContributions()` seals.
 */
export interface LaunchOptionInfo {
  id: string;
  def: LaunchOptionDef<unknown>;
  summarize?: (value: unknown) => string | null;
}

const OptionSlot = defineRenderSlot<TaskLaunchOption<unknown>>({
  docLabel: (p) => p.label,
  // Size-owning: every contributed control inherits `sm`, in both hosts.
  controlSize: "sm",
});

/**
 * The one erasure in the contract. `V` is what ties `def`, `component`,
 * `useTaskBinding` and `summarize` together, so it must survive to the call
 * site — but the slot can only store one type. Widening here (rather than
 * declaring the slot over `unknown` and letting each contributor cast) keeps
 * every contribution internally type-checked.
 */
function contributeOption<V>(option: TaskLaunchOption<V> & { id: string }) {
  return OptionSlot(option as unknown as LaunchOptionEntry);
}

/**
 * The launch-option registry, rendered by BOTH surfaces: the task detail's
 * Prompt card and the task-draft popover. `TaskLaunch.Option` is the generic
 * contribution factory above with the render slot's own members (`.Render`,
 * `.useContributions`, `.id`) folded onto it, so one name is both how an option
 * is contributed and how a host reads the set.
 */
export const TaskLaunch = {
  Option: defineSlotFacade(contributeOption, OptionSlot),
};
