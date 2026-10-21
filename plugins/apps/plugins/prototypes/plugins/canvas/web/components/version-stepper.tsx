import { useMemo, useState, type ReactElement } from "react";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { subThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ActionFormShield } from "@plugins/primitives/plugins/action-presentation/web";
import {
  prototypeHistory,
  restorePrototypeVersion,
  type OptionPicks,
  type PrototypeHistory,
  type PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { isPastStep, type VersionStep } from "../internal/version-steps";
import { useVersionStepping } from "../internal/use-version-stepping";
import { frameChipsTheme } from "../internal/sub-themes";
import { VersionList, VersionListFrameContext } from "./version-list";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const chevronLeftIcon = symbol("chevron-left");
const chevronRightIcon = symbol("chevron-right");
const chevronDownIcon = symbol("keyboard-arrow-down");
const historyIcon = symbol("history");

/** Which version a stepper moves: the pair, so every frame steps on its own. */
export interface VersionStepperProps {
  /** The prototype's id (its history is keyed by it). */
  name: string;
  /** The version on screen — `null` for the live folder. */
  shown: PrototypeVersion | null;
  show: (version: PrototypeVersion | null) => void;
  /** Open `version` in a new frame beside this one (a list row action). */
  compare?: (version: PrototypeVersion) => void;
  /**
   * The frame's picks (defaults left out): the version list's "This variant"
   * filter keeps the versions that declare them. Absent → no filter.
   */
  picks?: OptionPicks;
  /** The narrow form (a frame under 440px): no age beside the number. */
  narrow?: boolean;
}

/**
 * `‹ v24 latest ⌄ ›` — one frame's version (the mockup's `.vstep`). The arrows
 * step; the label opens the version list under it, which on a past version
 * ends with **Make vN the latest**.
 *
 * The arrows never move: the label keeps one width in every state (a floor
 * wide enough for every form), so stepping never slides the › out from under
 * the pointer.
 *
 * Pending history renders disabled arrows over a loading label — never a "v0"
 * that is really "not loaded yet".
 *
 * Its controls are the frame box's own 22px / 20px chips (`frameChipsTheme`),
 * worn here so the stepper looks the same wherever it is mounted.
 */
export function VersionStepper(props: VersionStepperProps): ReactElement {
  const history = useLive(prototypeHistory, { name: props.name });
  const narrow = props.narrow ?? false;
  // The stepper's ‹ › and label are parts of it, not occupants of a bar it
  // may sit in that each declare a form of their own.
  return (
    <ActionFormShield>
      <Theme
        name={subThemeScope(frameChipsTheme)}
        surface="none"
        as={Line}
        role="group"
        aria-label="Version"
      >
        {matchResource(history, {
          loading: () => <PendingStepper narrow={narrow} />,
          error: (err) => (
            <Text variant="caption" tone="destructive" title={err.message}>
              History unavailable
            </Text>
          ),
          ready: (h) => <ReadyStepper history={h} {...props} narrow={narrow} />,
        })}
      </Theme>
    </ActionFormShield>
  );
}

/**
 * The label's floor: wide enough for every form (`v24 latest ⌄`, `v24 6d ago
 * ⌄`, `Live unsaved ⌄`; narrow: `v124 ⌄`), so the arrows never move.
 */
const labelFloor = (narrow: boolean) => (narrow ? "min-w-14" : "min-w-25");

/** The ‹ / › — 20px, dimmed to .3 at either end. */
function Arrow({
  side,
  onClick,
  disabled,
}: {
  side: "prev" | "next";
  onClick?: () => void;
  disabled: boolean;
}): ReactElement {
  return (
    <ControlSizeProvider size="xs">
      <IconButton
        icon={side === "prev" ? chevronLeftIcon : chevronRightIcon}
        label={side === "prev" ? "Previous version" : "Next version"}
        disabled={disabled}
        onClick={onClick}
        className="disabled:opacity-30"
      />
    </ControlSizeProvider>
  );
}

function PendingStepper({ narrow }: { narrow: boolean }): ReactElement {
  return (
    <>
      <Arrow side="prev" disabled />
      <ControlSizeProvider size="sm">
        <Button variant="ghost" disabled className={labelFloor(narrow)}>
          <Loading variant="block" className="h-3 w-12" />
        </Button>
      </ControlSizeProvider>
      <Arrow side="next" disabled />
    </>
  );
}

function ReadyStepper({
  history,
  name,
  shown,
  show,
  compare,
  picks,
  narrow,
}: VersionStepperProps & {
  history: PrototypeHistory;
  narrow: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const { model, current, prev, next, go, stepBack, stepForward } =
    useVersionStepping(history, { shown, show });
  // The version a past stop shows — what "Make vN the latest" restores.
  const restorable =
    current?.kind === "version" && isPastStep(current) ? current.version : null;
  const shownSha =
    current?.kind === "version" ? current.version.sha : undefined;
  // What the list's row actions may do to this frame (Compare in a new frame).
  const listFrame = useMemo(
    () => ({
      shownSha,
      compare:
        compare === undefined
          ? undefined
          : (version: PrototypeVersion) => {
              setOpen(false);
              compare(version);
            },
    }),
    [shownSha, compare],
  );

  return (
    <>
      <Arrow side="prev" disabled={prev === null} onClick={stepBack} />
      {/* The label is a 22px `sm` chip (the popup leaves the sub-theme, so
          the list's own `sm` controls are the app's). */}
      <ControlSizeProvider size="sm">
        <InlinePopover
          open={open}
          onOpenChange={setOpen}
          side="bottom"
          align="center"
          width="described"
          // Every open starts from the top of the list's state — the current
          // version scrolled into view, the variant filter on.
          resetOnClose
          tooltip={<StepTooltip step={current} />}
          trigger={
            <Button variant="ghost" className={labelFloor(narrow)}>
              <StepLabel step={current} narrow={narrow} />
              <Icon
                icon={chevronDownIcon}
                className="size-2.75 text-faint-foreground"
              />
            </Button>
          }
        >
          <Stack gap="2xs">
            <VersionListFrameContext value={listFrame}>
              <VersionList
                history={history}
                picks={picks}
                selected={shownSha}
                onPick={(version) => {
                  const step = model.steps.find(
                    (s) =>
                      s.kind === "version" && s.version.sha === version.sha,
                  );
                  go(step ?? null);
                  setOpen(false);
                }}
              />
            </VersionListFrameContext>
            {restorable !== null ? (
              <Button
                variant="ghost"
                className="text-warning"
                onClick={() => {
                  setOpen(false);
                  confirmRestore(name, restorable, show);
                }}
              >
                <Icon icon={historyIcon} />
                Make v{restorable.n} the latest
              </Button>
            ) : null}
          </Stack>
        </InlinePopover>
      </ControlSizeProvider>
      <Arrow side="next" disabled={next === null} onClick={stepForward} />
    </>
  );
}

/**
 * `v24` (mono 500) and, dimmed, `latest` / `6d ago` — or `Live unsaved` past
 * the newest version. The narrow form drops the dimmed half.
 */
function StepLabel({
  step,
  narrow,
}: {
  step: VersionStep | null;
  narrow: boolean;
}): ReactElement {
  if (step === null) {
    return (
      <Text variant="tag" className="text-warning">
        Unknown
      </Text>
    );
  }
  const [number, age] =
    step.kind === "unsaved"
      ? [
          <Text key="n" variant="tag" className="font-medium text-foreground">
            Live
          </Text>,
          "unsaved",
        ]
      : [
          <Text
            key="n"
            variant="code"
            className="font-medium text-foreground tabular-nums"
          >
            {`v${String(step.version.n)}`}
          </Text>,
          step.live ? (
            "latest"
          ) : (
            <RelativeTime date={new Date(step.version.at)} format="ago" />
          ),
        ];
  return (
    <>
      {number}
      {narrow ? null : (
        <span className="text-2xs text-faint-foreground">{age}</span>
      )}
    </>
  );
}

/**
 * What the label's tooltip says about the stop on screen: the request that made
 * it and when, or — for the unsaved stop — what "unsaved" means here.
 */
function StepTooltip({ step }: { step: VersionStep | null }) {
  if (step === null) {
    return "This version is no longer in the prototype's history.";
  }
  if (step.kind === "unsaved") {
    return (
      <Stack gap="2xs">
        <Text>Live · changes no version holds yet</Text>
        <Text variant="caption" tone="muted">
          The next agent turn that edits this prototype records them.
        </Text>
      </Stack>
    );
  }
  return (
    <Stack gap="2xs">
      <Text>{step.version.subject}</Text>
      <Text variant="caption" tone="muted">
        v{step.version.n} · <RelativeTime date={new Date(step.version.at)} />
      </Text>
    </Stack>
  );
}

/**
 * Make `version` the latest: confirm, then restore it. The store saves the
 * current state first, so this loses nothing — which the dialog says, since
 * that is what makes it safe to click. On success the frame goes back to live,
 * where the restored design now is.
 */
function confirmRestore(
  name: string,
  version: PrototypeVersion,
  show: (version: PrototypeVersion | null) => void,
) {
  void confirmDialog({
    title: `Make v${String(version.n)} the latest?`,
    description:
      "Its files replace the live prototype. The current state is saved as a version first, so nothing is lost — you can step back to it.",
    confirmLabel: "Make it the latest",
    onConfirm: async () => {
      const restored = await fetchEndpoint(restorePrototypeVersion, {
        name,
        sha: version.sha,
      });
      show(null);
      showToast({
        title: `Restored v${String(version.n)}`,
        description: `Recorded as v${String(restored.n)}.`,
        variant: "success",
      });
    },
  });
}
