import { useId, useRef, useState } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Button,
  type PopoverWidth,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { type PaneOpenMode } from "@plugins/primitives/plugins/pane/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { ComposerField } from "@plugins/primitives/plugins/text-editor/plugins/composer/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import {
  LaunchOptionPills,
  type LaunchOptionValues,
} from "@plugins/tasks/plugins/launch-options/web";
import { type LaunchTaskResponse } from "@plugins/tasks/core";
import type { TaskSubject } from "@plugins/tasks/plugins/task-subject/core";
import { useClaudeCodeLaunchBlock } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { useTaskLaunch } from "./use-task-launch";

/**
 * An on/off choice the caller adds to the form. The form draws it and hands
 * its current value to `getRequest`; what it means (usually a paragraph added
 * to the prompt) is the caller's.
 */
export type LaunchToggle = {
  /** Key of this toggle's value in `getRequest`'s `toggles` argument. */
  id: string;
  label: string;
  /** Muted second line under the label. */
  description?: string;
  /** Starting value. Defaults to `false`. */
  defaultValue?: boolean;
};

/**
 * What a launch from the form is about: the prompt, and the task it runs —
 * either one that already exists, or a new one filed under `categoryId` and
 * titled with the form's own `title`. There is no fork or attempt arm: the form
 * always files a task, so a launch that must not mint one uses `LaunchControl`.
 */
export type LaunchAgentRequest = { prompt: string } & (
  | { taskId: string }
  | {
      categoryId: string;
      /**
       * The record the new task is ABOUT (a failed run). Its live task, when
       * it has one, is reused instead of filing another (`tasks/task-subject`).
       */
      subject?: TaskSubject;
    }
);

/** Everything the user has entered and not launched yet. */
type LaunchDraft = {
  text: string;
  /** Only the options the user changed — see `picked` in the form. */
  picked: LaunchOptionValues;
  toggles: Record<string, boolean>;
};

export type LaunchAgentFormProps = {
  /**
   * Names WHAT this launch is about (e.g. `build-fix:<runId>`), so the user's
   * unsent draft — context text, options, toggles — is saved under it and comes
   * back when the form is shown again: after the popover is closed, the host
   * unmounts, or the page reloads. Cleared once the launch is filed. Required:
   * a launch form that loses what was typed into it is a bug, not a default.
   */
  draftKey: string;
  title: string;
  description: React.ReactNode;
  placeholder?: string;
  /** Receives the typed text and every toggle's value, keyed by its `id`. */
  getRequest: (
    userText: string,
    toggles: Readonly<Record<string, boolean>>,
  ) => LaunchAgentRequest | Promise<LaunchAgentRequest>;
  toggles?: readonly LaunchToggle[];
  disabled?: boolean;
  /**
   * Called once the task is filed. `started: false` is a legitimate outcome,
   * not a failure: the user picked Off on the run pill, so the task was filed
   * without starting.
   */
  onSubmitted?: (result: LaunchTaskResponse) => void;
  /**
   * Whether launching also OPENS the conversation it started. Defaults to
   * `false` — the fire-and-forget background launch every caller of
   * `LaunchAgentPopover` has always got, so hosting the form somewhere else is
   * what opts into the pane, never the other way round.
   */
  openAfterLaunch?: boolean;
  /** Where that conversation opens, when it does. */
  openMode?: PaneOpenMode;
};

/**
 * The launch FORM: what the user reads (title + description), one composer
 * field holding the free-form extra context and — on its own bar, inside the
 * same box — the registered launch options (preprompt, model, thinking mode…),
 * then the caller's toggles, then the Launch button.
 *
 * Submitting files a task carrying those options and starts it now, so they
 * are the task's durable settings rather than one conversation's. It owns the
 * context text and every one of those choices; the host owns where the form
 * sits and what happens after a launch.
 *
 * It is a form and not a popover because a second host needs exactly this body
 * inside a popover it already owns (a container card's glyph panel), and an
 * `InlinePopover` nested in another popover is not an option.
 */
export function LaunchAgentForm({
  draftKey,
  title,
  description,
  placeholder = "Extra context (optional)…",
  getRequest,
  toggles = [],
  disabled,
  onSubmitted,
  openAfterLaunch = false,
  openMode = "push",
}: LaunchAgentFormProps) {
  const [draft, setDraft, clearDraft] = useDraft<LaunchDraft>(
    `launch-agent:${draftKey}`,
    { text: "", picked: {}, toggles: {} },
  );
  const { text, picked } = draft;
  // Only what the user changed; the rest reads through to the registry's
  // defaults, so an option registered after mount is still sent with its seed.
  const { resolveOptions, launch } = useTaskLaunch({
    openAfterLaunch,
    openMode,
  });
  const options = resolveOptions(picked);
  // Same read-through for toggles: the draft holds only flipped ones.
  const toggleValues: Record<string, boolean> = {
    ...Object.fromEntries(toggles.map((t) => [t.id, t.defaultValue ?? false])),
    ...draft.toggles,
  };
  const setPickedOptions = (next: LaunchOptionValues) =>
    setDraft((d) => ({ ...d, picked: next }));
  // Stable per-instance Lexical namespace so multiple forms don't collide.
  const editorId = useId();
  // Claude Code missing or signed out: say so, with the fix, where the Launch
  // button is — rather than filing a launch that cannot run.
  const claudeBlock = useClaudeCodeLaunchBlock();

  // One launch at a time, whichever of ⌘Enter or the button asked for it: the
  // ref closes the gap before the re-render, the state drives the button's
  // spinner for a keyboard launch too.
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const blocked = disabled || claudeBlock !== null;
  const trySubmit = async () => {
    if (inFlight.current || blocked) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      await submit();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const submit = async () => {
    const req = await getRequest(text, toggleValues);
    const result = await launch(
      req.prompt,
      picked,
      "taskId" in req
        ? { id: req.taskId }
        : { title, categoryId: req.categoryId, subject: req.subject },
    );
    clearDraft();
    onSubmitted?.(result);
  };

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Text as="div" variant="label">
          {title}
        </Text>
        <Text as="div" variant="caption" tone="muted">
          {description}
        </Text>
      </Stack>
      <ComposerField
        value={text}
        onChange={(next) => setDraft((d) => ({ ...d, text: next }))}
        placeholder={placeholder}
        onSubmit={() => void trySubmit()}
        submitMode="cmd-enter"
        minRows={3}
        maxHeight="16rem"
        namespace={`launch-agent-form-${editorId}`}
        barStart={
          <LaunchOptionPills
            side="start"
            values={options}
            onChange={setPickedOptions}
            disabled={disabled ?? false}
          />
        }
        barEnd={
          <LaunchOptionPills
            side="end"
            values={options}
            onChange={setPickedOptions}
            disabled={disabled ?? false}
          />
        }
      />
      {toggles.map((t) => (
        <LaunchToggleRow
          key={t.id}
          toggle={t}
          checked={toggleValues[t.id] ?? false}
          onCheckedChange={(checked) =>
            setDraft((d) => ({
              ...d,
              toggles: { ...d.toggles, [t.id]: checked },
            }))
          }
        />
      ))}
      {claudeBlock !== null ? (
        <Text as="div" variant="caption" tone="destructive">
          {claudeBlock}
        </Text>
      ) : null}
      <Line>
        {/* The empty flexible cell: the button sits flush right in its own
            track rather than floating over the toggles above it. */}
        <Fill />
        <Button disabled={blocked} loading={submitting} onClick={trySubmit}>
          Launch
        </Button>
      </Line>
    </Stack>
  );
}

function LaunchToggleRow({
  toggle,
  checked,
  onCheckedChange,
}: {
  toggle: LaunchToggle;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const switchId = useId();
  return (
    <Stack direction="row" gap="sm" align="start">
      <Switch
        id={switchId}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
      {/* A `<label for>` names the switch with both lines, and clicking either
          line flips it. */}
      <label htmlFor={switchId} className="cursor-pointer select-none">
        <Stack as="span" gap="none">
          <Text variant="label">{toggle.label}</Text>
          {toggle.description ? (
            <Text variant="caption" tone="muted">
              {toggle.description}
            </Text>
          ) : null}
        </Stack>
      </label>
    </Stack>
  );
}

/**
 * The popover's props are the form's, MINUS the two knobs about opening the
 * launched conversation: this surface is always a fire-and-forget background
 * launch (the "Conversation started" notification confirms it), so neither is
 * a caller's to set.
 */
export type LaunchAgentPopoverProps = Omit<
  LaunchAgentFormProps,
  "openAfterLaunch" | "openMode"
> & {
  trigger: React.ReactElement;
  align?: "start" | "end";
  width?: PopoverWidth;
};

export function LaunchAgentPopover({
  trigger,
  align = "start",
  width = "3xl",
  onSubmitted,
  ...form
}: LaunchAgentPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <InlinePopover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      align={align}
      width={width}
    >
      <LaunchAgentForm
        {...form}
        onSubmitted={(result) => {
          // Either outcome ends the popover's job: the task is filed, started
          // or not.
          setOpen(false);
          onSubmitted?.(result);
        }}
      />
    </InlinePopover>
  );
}
