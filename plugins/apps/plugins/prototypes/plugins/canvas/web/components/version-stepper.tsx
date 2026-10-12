import { useMemo, useState, type ReactElement } from "react";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  ActionFormShield,
  useActionForm,
} from "@plugins/primitives/plugins/action-presentation/web";
import {
  prototypeHistory,
  restorePrototypeVersion,
  type PrototypeHistory,
  type PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { isPastStep, type VersionStep } from "../internal/version-steps";
import { useVersionStepping } from "../internal/use-version-stepping";
import { VersionList, VersionListFrameContext } from "./version-list";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const chevronLeftIcon = symbol("chevron-left");
const chevronRightIcon = symbol("chevron-right");
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
}

/**
 * `‹ v14 · latest ›` — one frame's version. The arrows step; the label opens
 * the version list, which on a past version ends with **Make vN the latest**.
 *
 * The arrows never move: the label keeps one width in every state, so
 * stepping never slides the › out from under the pointer.
 *
 * Pending history renders disabled arrows over a loading label — never a "v0"
 * that is really "not loaded yet".
 *
 * In a bar that runs out of room (a narrow canvas frame's header) it shrinks to
 * its compact form: the bare `v14` label, still opening the version list, with
 * no arrows and no floor — `[` / `]` still step the selected frame. It gives up
 * room late, after its neighbours, since it is what a frame's header is for.
 */
export function VersionStepper(props: VersionStepperProps): ReactElement {
  const history = useLive(prototypeHistory, { name: props.name });
  const compact =
    useActionForm({ shrinksTo: ["compact"], yields: "late" }) === "compact";
  // The stepper's own ladder is its item's: its ‹ › and label are parts of
  // it, not occupants that may each declare a form of their own.
  return (
    <ControlSizeProvider size="xs">
      <ActionFormShield>
        {matchResource(history, {
          loading: () => <PendingStepper compact={compact} />,
          error: (err) => (
            <Text variant="caption" tone="destructive" title={err.message}>
              History unavailable
            </Text>
          ),
          ready: (h) => (
            <ReadyStepper history={h} compact={compact} {...props} />
          ),
        })}
      </ActionFormShield>
    </ControlSizeProvider>
  );
}

/** The label's floor: wide enough for every form, so the arrows never move. */
const LABEL_WIDTH = "min-w-24";

function Pill({
  past,
  children,
}: {
  past: boolean;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <Stack
      direction="row"
      gap="none"
      align="center"
      role="group"
      aria-label="Version"
      className={cn(
        "rounded-full border",
        past ? "border-warning/50" : "border-border",
      )}
    >
      {children}
    </Stack>
  );
}

function PendingStepper({ compact }: { compact: boolean }): ReactElement {
  const label = (
    <Button
      variant="ghost"
      disabled
      className={compact ? undefined : LABEL_WIDTH}
    >
      <Loading variant="block" className={compact ? "h-3 w-6" : "h-3 w-12"} />
    </Button>
  );
  if (compact) return <Pill past={false}>{label}</Pill>;
  return (
    <Pill past={false}>
      <IconButton icon={chevronLeftIcon} label="Previous version" disabled />
      {label}
      <IconButton icon={chevronRightIcon} label="Next version" disabled />
    </Pill>
  );
}

function ReadyStepper({
  history,
  name,
  shown,
  show,
  compare,
  compact,
}: VersionStepperProps & {
  history: PrototypeHistory;
  /** The bare label: no arrows, no floor, no `· latest` suffix. */
  compact: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const { model, current, prev, next, go, stepBack, stepForward } =
    useVersionStepping(history, { shown, show });
  const past = current === null || isPastStep(current);
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

  const list = (
    <InlinePopover
      open={open}
      onOpenChange={setOpen}
      align="start"
      width="lg"
      maxHeight="xl"
      tooltip={<StepTooltip step={current} />}
      trigger={
        <Button
          variant="ghost"
          className={cn(!compact && LABEL_WIDTH, "rounded-full")}
        >
          <StepLabel step={current} compact={compact} />
        </Button>
      }
    >
      <Stack gap="xs">
        <SectionLabel>Versions</SectionLabel>
        <VersionListFrameContext value={listFrame}>
          <VersionList
            history={history}
            selected={shownSha}
            onPick={(version) => {
              const step = model.steps.find(
                (s) => s.kind === "version" && s.version.sha === version.sha,
              );
              go(step ?? null);
              setOpen(false);
            }}
          />
        </VersionListFrameContext>
        {restorable !== null ? (
          <Button
            variant="secondary"
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
  );
  if (compact) return <Pill past={past}>{list}</Pill>;
  return (
    <Pill past={past}>
      <IconButton
        icon={chevronLeftIcon}
        label="Previous version"
        disabled={prev === null}
        onClick={stepBack}
      />
      {list}
      <IconButton
        icon={chevronRightIcon}
        label="Next version"
        disabled={next === null}
        onClick={stepForward}
      />
    </Pill>
  );
}

/**
 * `v14 · latest` (the suffix dimmed) — or `v11` in the past-version colour.
 * Compact drops the suffix: `v14`, `Live`.
 */
function StepLabel({
  step,
  compact,
}: {
  step: VersionStep | null;
  compact: boolean;
}): ReactElement {
  if (step === null) {
    return <span className="text-warning">Unknown</span>;
  }
  if (compact) {
    return step.kind === "unsaved" ? (
      <span>Live</span>
    ) : (
      <span className={cn("tabular-nums", !step.live && "text-warning")}>
        v{step.version.n}
      </span>
    );
  }
  if (step.kind === "unsaved") {
    return (
      <Line>
        <span>Live</span>
        <span className="whitespace-pre text-muted-foreground"> · unsaved</span>
      </Line>
    );
  }
  if (step.live) {
    return (
      <Line>
        <span className="tabular-nums">v{step.version.n}</span>
        <span className="whitespace-pre text-muted-foreground"> · latest</span>
      </Line>
    );
  }
  return <span className="tabular-nums text-warning">v{step.version.n}</span>;
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
