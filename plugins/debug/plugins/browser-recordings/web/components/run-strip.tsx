import { hostFileUrl } from "@plugins/infra/plugins/host-fs/core";
import {
  ImageGallery,
  ViewerThumbnail,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { BrowserRecordingRun, RecordingStep } from "../../core";

/**
 * One run's filmstrip: a frame per step (the page as the step ended), the
 * failing step ringed. Each run is its own gallery, so the full-window viewer
 * steps — or slideshows — through that run's frames only. An e2e run is
 * captioned with its script; a browser_* call's frame is the call's own
 * picture, its card already says what it did.
 */
export function RunStrip({ run }: { run: BrowserRecordingRun }) {
  const { steps } = run;
  const frames = distinctFrames(steps);
  const failed = steps.filter((s) => s.error !== undefined).length;
  const source =
    run.source.kind === "e2e"
      ? (run.source.script.split("/").at(-1) ?? run.source.script)
      : run.source.tool;
  return (
    <Stack gap="2xs" data-browser-recording={run.dir}>
      {run.source.kind === "e2e" ? (
        <Text variant="caption" tone="muted">
          Recording · {source} · {steps.length} steps
          {failed > 0 ? ` · ${failed} failed` : ""}
        </Text>
      ) : null}
      <ImageGallery>
        <Scroll axis="x">
          <Stack direction="row" gap="xs">
            {frames.map(({ frame, step, index }) => (
              <span
                key={frame}
                title={`${index + 1}. ${step.title}${step.error ? `\n${step.error}` : ""}`}
                className={
                  step.error !== undefined
                    ? "rounded-md ring-2 ring-destructive"
                    : undefined
                }
              >
                <ViewerThumbnail
                  size="chip"
                  image={{
                    src: hostFileUrl(frame),
                    name: `${index + 1}/${steps.length} · ${step.title}`,
                    sourceLabel: source,
                  }}
                />
              </span>
            ))}
          </Stack>
        </Scroll>
      </ImageGallery>
    </Stack>
  );
}

/**
 * One thumbnail per picture: consecutive steps that ended on the same frame
 * (a wait, an evaluate) fold into the last of them — or the failing one.
 */
function distinctFrames(
  steps: readonly RecordingStep[],
): { frame: string; step: RecordingStep; index: number }[] {
  const out: { frame: string; step: RecordingStep; index: number }[] = [];
  steps.forEach((step, index) => {
    if (step.frame === undefined) return;
    const prev = out.at(-1);
    if (prev?.frame === step.frame) {
      if (prev.step.error === undefined) {
        prev.step = step;
        prev.index = index;
      }
      return;
    }
    out.push({ frame: step.frame, step, index });
  });
  return out;
}
