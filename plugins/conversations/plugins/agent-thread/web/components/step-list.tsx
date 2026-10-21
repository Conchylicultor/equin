import { useState } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { FoldMotion } from "@plugins/primitives/plugins/collapsible/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  resultCountOf,
  type ThreadStep,
  type ThreadStepState,
  type ThreadTurn,
} from "../../core";
import type { ResultWords } from "./result-words";
import { AgentThreadSlots } from "../slots";

const doneIcon = symbol("check");
const errorIcon = symbol("error");
const expandIcon = symbol("expand-more");
const collapseIcon = symbol("expand-less");

function StepGlyph({ state }: { state: ThreadStepState }) {
  switch (state) {
    case "running":
      return <Spinner shape="ring" className="size-3" />;
    case "done":
      return (
        <Icon
          icon={doneIcon}
          className={cn("icon-auto text-muted-foreground", rigidClass())}
        />
      );
    case "error":
      return (
        <Icon
          icon={errorIcon}
          className={cn("icon-auto text-destructive", rigidClass())}
        />
      );
  }
}

/**
 * One step's words, through the `StepLabel` dispatch — for a host's own
 * surface too (a progress pill's "step 3 · Searched Google…").
 */
export function StepLabel({ step }: { step: Pick<ThreadStep, "event"> }) {
  return <AgentThreadSlots.StepLabel.Dispatch event={step.event} />;
}

function StepRow({ step }: { step: ThreadStep }) {
  return (
    <Line className="gap-xs">
      <StepGlyph state={step.state} />
      <Fill>
        <Text
          variant="caption"
          tone={step.state === "error" ? "destructive" : "default"}
        >
          <StepLabel step={step} />
        </Text>
      </Fill>
    </Line>
  );
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * "4 steps · 2 results · 1 failed" — a finished turn's steps, folded. A step
 * that erred is counted, so the fold never hides that something went wrong.
 */
function summaryOf(turn: ThreadTurn, resultWords: ResultWords): string {
  const parts = [plural(turn.steps.length, "step")];
  const results = resultCountOf(turn.results);
  if (results > 0) parts.push(resultWords(results));
  const failed = turn.steps.filter((s) => s.state === "error").length;
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/**
 * A turn's steps: live while the turn runs, folded behind one summary button
 * once it is done (a failed turn stays open, so its red step shows). The
 * button re-opens it.
 */
export function StepList({
  turn,
  resultWords,
}: {
  turn: ThreadTurn;
  /** How the fold counts the turn's results ("8 picks"). */
  resultWords: ResultWords;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  if (turn.steps.length === 0) return null;
  const foldable = turn.state === "done";
  const open = !foldable || (override ?? false);

  return (
    <Stack gap="2xs">
      {foldable && (
        <Line>
          <Button
            variant="ghost"
            aria-expanded={open}
            onClick={() => setOverride(!open)}
          >
            <Icon icon={doneIcon} className="icon-auto" aria-hidden />
            {summaryOf(turn, resultWords)}
            <Icon
              icon={open ? collapseIcon : expandIcon}
              className="icon-auto"
              aria-hidden
            />
          </Button>
        </Line>
      )}
      <FoldMotion open={open}>
        <Stack gap="2xs">
          {turn.steps.map((step) => (
            <StepRow key={step.event.toolUseId} step={step} />
          ))}
        </Stack>
      </FoldMotion>
    </Stack>
  );
}
