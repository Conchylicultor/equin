import { useState, type ReactNode } from "react";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  issueTitle,
  readableIdea,
} from "@plugins/integrations/plugins/github-issues/core";
import "./replay-steps.css";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkIcon = symbol("check");

/** What one replay plays: the visitor's idea, and the facts drawn for it. */
export interface ReplayRun {
  /** The idea as submitted — raw `<ui-context>` tags for its picks included. */
  text: string;
  /** Whether the visitor asked to ship without a review — picks the last step. */
  autoDeploy: boolean;
  /** The pretend branch, `improve-xxxx`, drawn once per replay. */
  branch: string;
  /** Read once when the replay starts: show every step done, with no motion. */
  reducedMotion: boolean;
}

type StepState = "pending" | "active" | "done";

interface ScriptStep {
  title: string;
  detail: ReactNode;
  /** How long the step stays active: a real run's minutes, sped up to seconds. */
  durationMs: number;
}

function Detail({ children }: { children: ReactNode }) {
  return (
    <Text as="p" variant="caption" tone="muted">
      {children}
    </Text>
  );
}

/**
 * The replay's script — what equin does with an idea, in order. Fixed steps, not
 * records of anything that happened, which is why this is a literal list and
 * the pacing is authored here rather than measured.
 */
function script({ text, autoDeploy, branch }: ReplayRun): ScriptStep[] {
  const branchChip = <Badge mono>{branch}</Badge>;
  // The code behind the first pick the build stamped a source on. A pick is
  // the visitor saying "this part", so it is what the agent would open first.
  const pickedFile = readableIdea(text).picks.find((pick) => pick.file)?.file;
  return [
    {
      title: "Task filed",
      durationMs: 500,
      // The idea's first line, as the task's title would read — picks as their
      // readable labels, never a raw tag — one line, ellipsized to the column
      // rather than wrapped into a paragraph.
      detail: (
        <Line>
          <Text variant="caption" tone="muted" className="italic">
            “{issueTitle(text)}”
          </Text>
        </Line>
      ),
    },
    {
      title: "Its own copy of the app",
      durationMs: 900,
      detail: <Detail>Branched from main as {branchChip}</Detail>,
    },
    {
      title: "An agent makes the change",
      durationMs: 1600,
      detail: pickedFile ? (
        <Detail>
          Reads <Badge mono>{pickedFile}</Badge>, the code behind what you
          pointed at
        </Detail>
      ) : (
        <Detail>Finds the code behind this page and edits it</Detail>
      ),
    },
    {
      title: "Checks pass",
      durationMs: 900,
      detail: <Detail>Types, plugin boundaries and tests</Detail>,
    },
    autoDeploy
      ? {
          title: "Merged & deployed",
          durationMs: 700,
          detail: <Detail>Shipped as soon as checks passed</Detail>,
        }
      : {
          title: "Preview is live",
          durationMs: 700,
          detail: (
            <Stack gap="sm">
              <Detail>At {branchChip}, beside the real page</Detail>
              {/* What the reviewer would click. Drawn, not wired: there is no
                  preview behind this site, so they stay disabled. */}
              <ControlSizeProvider size="xs">
                <Cluster gap="xs">
                  <Button variant="outline" disabled>
                    Open preview
                  </Button>
                  <Button variant="outline" disabled>
                    Merge & deploy
                  </Button>
                  <Button variant="outline" disabled>
                    Send back
                  </Button>
                </Cluster>
              </ControlSizeProvider>
            </Stack>
          ),
        },
  ];
}

/**
 * The scripted replay of equin's loop, played step by step: each step is
 * pending, then active (a spinner, and a hairline filling over the step's
 * duration), then done.
 *
 * The replay is driven by the CSS it shows. Only the active step mounts its
 * progress bar, and that bar's `animationend` is what moves the replay on — no
 * timer chain to drift from the animation or to clear, and a closed popover
 * (which unmounts all of this) simply stops it. Under reduced motion the replay
 * opens already finished.
 */
export function ReplaySteps({ run }: { run: ReplayRun }) {
  const steps = script(run);
  // The step in progress; `steps.length` once every step is done.
  const [current, setCurrent] = useState(run.reducedMotion ? steps.length : 0);
  return (
    <Stack as="ol" gap="none" aria-label="Replay steps">
      {steps.map((step, i) => (
        <ReplayStep
          key={step.title}
          step={step}
          state={i < current ? "done" : i === current ? "active" : "pending"}
          isLast={i === steps.length - 1}
          onFinished={() => setCurrent((c) => Math.max(c, i + 1))}
        />
      ))}
    </Stack>
  );
}

/**
 * One step: a dot on a rail, then the title, the detail, and the progress
 * hairline. The hairline's box is always there (empty unless the step is
 * active), so a step starting or finishing never moves the steps below it.
 */
function ReplayStep({
  step,
  state,
  isLast,
  onFinished,
}: {
  step: ScriptStep;
  state: StepState;
  isLast: boolean;
  onFinished: () => void;
}) {
  return (
    <Stack
      as="li"
      direction="row"
      gap="md"
      data-state={state}
      aria-current={state === "active" ? "step" : undefined}
      className={cn(
        "motion-safe:transition-opacity",
        state === "pending" && "opacity-40",
      )}
    >
      {/* Default cross-axis stretch keeps this column at full row height, so
          the rail below the dot runs down to the next step's dot. */}
      <Stack direction="col" align="center" gap="none">
        <StepDot state={state} />
        {!isLast && <Fill axis="y" aria-hidden className="bg-border w-px" />}
      </Stack>
      <Fill>
        <Stack
          gap="2xs"
          className={isLast ? undefined : insetClass({ b: "md" })}
        >
          <Text as="span" variant="label" className="font-semibold">
            {step.title}
          </Text>
          {step.detail}
          <span
            aria-hidden
            className={cn(
              "block h-0.5 w-full rounded-full",
              state === "active" && "bg-border",
            )}
          >
            {state === "active" && (
              <span
                className="website-improve-progress bg-primary block h-full rounded-full"
                style={{ animationDuration: `${step.durationMs}ms` }}
                onAnimationEnd={(e) => {
                  if (e.target === e.currentTarget) onFinished();
                }}
              />
            )}
          </span>
        </Stack>
      </Fill>
    </Stack>
  );
}

/** Empty ring while pending, a spinner while active, a filled check once done. */
function StepDot({ state }: { state: StepState }) {
  return (
    <Center
      aria-hidden
      className={cn(
        "size-5.5 rounded-full border",
        state === "done"
          ? "border-primary bg-primary text-primary-foreground"
          : state === "active"
            ? "border-primary/30 text-primary-text"
            : "border-border",
      )}
    >
      {state === "done" ? (
        <Icon icon={checkIcon} className="size-3.5" />
      ) : state === "active" ? (
        <Spinner className="size-3.5" />
      ) : null}
    </Center>
  );
}
