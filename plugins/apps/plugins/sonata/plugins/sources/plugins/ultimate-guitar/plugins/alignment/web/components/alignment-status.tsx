import type { ReactNode } from "react";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { cancelUgAlignment, realignUg, resolveUgAlignment } from "../../core";
import {
  ALIGN_STAGES,
  recordingStateLine,
  type AlignProgress,
  type AlignStage,
  type RecordingState,
} from "../internal/recording-state";
import { useInlineAction } from "../internal/use-inline-action";
import "./stage-progress.css";

const checkIcon = symbol("check-circle");
const warningIcon = symbol("warning");
const errorIcon = symbol("error");
const cancelIcon = symbol("cancel");
const videoIcon = symbol("smart-display");

const STAGE_LABEL: Record<AlignStage, string> = {
  find: "Find a video",
  analyse: "Analyse the audio",
  align: "Align the sheet",
};

/**
 * Find a video → Analyse the audio → Align the sheet: the stages before the
 * current one full, the current one an indeterminate sweep (nothing reports a
 * percentage), the rest empty; the current stage's label emphasised.
 */
function StageProgress({ progress }: { progress: AlignProgress }) {
  const current = ALIGN_STAGES.indexOf(progress.stage);
  return (
    <Grid cols={ALIGN_STAGES.length} gap="xs">
      {ALIGN_STAGES.map((stage, i) => (
        <Stack key={stage} gap="2xs">
          <Clip
            className={cn(
              "h-1 rounded-full bg-muted",
              i === current && "align-stage-current",
            )}
          >
            {i < current ? <div className="h-full bg-primary" /> : null}
          </Clip>
          <Text
            variant="caption"
            tone={i === current ? "default" : i < current ? "muted" : "faint"}
          >
            {STAGE_LABEL[stage]}
          </Text>
        </Stack>
      ))}
    </Grid>
  );
}

function StatusIcon({ state }: { state: RecordingState }): ReactNode {
  const glyph = (icon: IconRef, tone: string) => (
    <Icon icon={icon} className={tone} />
  );
  switch (state.kind) {
    case "loading":
      return null;
    case "working":
      return <Spinner className="text-primary-text" />;
    case "aligned":
      return glyph(checkIcon, "text-success");
    case "weak":
    case "needs-video":
      return glyph(warningIcon, "text-warning");
    case "out-of-date":
      return glyph(warningIcon, "text-muted-foreground");
    case "failed":
    case "unreadable":
      return glyph(errorIcon, "text-destructive");
    case "cancelled":
      return glyph(cancelIcon, "text-muted-foreground");
    case "no-video":
      return glyph(videoIcon, "text-muted-foreground");
  }
}

/**
 * Where the song's alignment stands, in one box: an icon, the status line and
 * the one control that fits it — Cancel while a job is on it, Re-align once
 * aligned (or out of date), Retry after a retryable failure or a cancel, Try
 * another (opens the video picker) for a weak match, Find a video with none; a
 * permanent failure offers nothing here (the video can only be replaced).
 * While working, the stage bar; after a failure, its message.
 */
export function AlignmentStatus({
  songId,
  state,
  onReplace,
}: {
  songId: string;
  state: RecordingState;
  /** Open the video picker (Replace). */
  onReplace: () => void;
}) {
  const { error, run } = useInlineAction();
  const cancel = useEndpointMutation(cancelUgAlignment, {
    meta: { suppressError: true },
  });
  const realign = useEndpointMutation(realignUg, {
    meta: { suppressError: true },
  });
  const resolve = useEndpointMutation(resolveUgAlignment, {
    meta: { suppressError: true },
  });
  const params = { params: { id: songId } };

  if (state.kind === "loading") return <Loading variant="text" />;

  const action = (label: string, onClick: () => void) => (
    <Button variant="ghost" onClick={onClick}>
      {label}
    </Button>
  );
  // A control that asks the computer to align: disabled, saying so, on a host
  // without it (the demo).
  const send = (label: string, mutation: typeof realign) =>
    mutation.kind === "unavailable" ? (
      <Button variant="ghost" disabled tooltip={mutation.message}>
        {label}
      </Button>
    ) : (
      action(label, () => void run(() => mutation.mutateAsync(params)))
    );
  const control = ((): ReactNode => {
    switch (state.kind) {
      case "working":
        return send("Cancel", cancel);
      case "aligned":
      case "out-of-date":
        return send("Re-align", realign);
      case "failed":
        return state.permanent ? null : send("Retry", realign);
      case "cancelled":
        return send("Retry", realign);
      case "weak":
      case "needs-video":
        return action("Try another", onReplace);
      case "no-video":
        return send("Find a video", resolve);
      case "unreadable":
        return null;
    }
  })();

  return (
    <Surface
      level="sunken"
      className={cn("rounded-lg", insetClass({ x: "md", y: "sm" }))}
    >
      <Stack gap="sm">
        <Line className="gap-sm">
          <StatusIcon state={state} />
          <Fill>
            <Text variant="label">{recordingStateLine(state)}</Text>
          </Fill>
          {control}
        </Line>
        {state.kind === "working" ? (
          <StageProgress progress={state.progress} />
        ) : null}
        {state.kind === "failed" ? (
          <Text variant="caption" tone="muted" role="alert">
            {state.message}
          </Text>
        ) : null}
        {error !== null ? (
          <Text variant="caption" tone="destructive" role="alert">
            {error}
          </Text>
        ) : null}
      </Stack>
    </Surface>
  );
}
