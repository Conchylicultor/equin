import { Fragment } from "react";
import {
  computerResizedAsset,
  fileUrl,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { assetUrlOver } from "@plugins/infra/plugins/endpoints/web";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import { AssetThumbnail } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { BrowserRecordingRun, StripFrame } from "../../core";

const count = (n: number): string => n.toLocaleString("en-US");

/**
 * One run's filmstrip: a frame per run of steps on the same picture (the page
 * as the step ended), the failing step ringed — at most `MAX_STRIP_FRAMES`,
 * the server's cut (first and last halves) marked where it skips. Each
 * thumbnail draws a small resized copy of the full-resolution frame; the
 * viewer opens the original. The strip opens no gallery of its own: its frames
 * join the enclosing one (the transcript's, the artifacts popover's), so ← / →
 * in the viewer walk on to the next call's screenshots. An e2e run is
 * captioned with its script; a browser_* call's frame is the call's own
 * picture, its card already says what it did.
 */
export function RunStrip({ run }: { run: BrowserRecordingRun }) {
  const source =
    run.source.kind === "e2e"
      ? (run.source.script.split("/").at(-1) ?? run.source.script)
      : run.source.tool;
  return (
    <Stack gap="2xs" data-browser-recording={run.dir}>
      {run.source.kind === "e2e" ? (
        <Text variant="caption" tone="muted">
          Recording · {source} · {count(run.calls)} steps
          {run.failed > 0 ? ` · ${count(run.failed)} failed` : ""}
          {run.omittedCalls > 0
            ? ` · ${count(run.omittedCalls)} not kept (over the recording's bound)`
            : ""}
        </Text>
      ) : null}
      <Scroll axis="x">
        <Stack direction="row" gap="xs" align="center">
          {run.strip.map((frame, i) => (
            <Fragment key={frame.frame}>
              {run.stripGap?.at === i ? (
                <Rigid as="span" className="px-xs">
                  <Text
                    variant="caption"
                    tone="muted"
                    className="whitespace-nowrap"
                  >
                    … {count(run.stripGap.frames)} more frames …
                  </Text>
                </Rigid>
              ) : null}
              <Frame frame={frame} run={run} source={source} />
            </Fragment>
          ))}
        </Stack>
      </Scroll>
    </Stack>
  );
}

function Frame({
  frame,
  run,
  source,
}: {
  frame: StripFrame;
  run: BrowserRecordingRun;
  source: string;
}) {
  const transport = useTransport();
  const asset = fileUrl({ fs: "computer", path: frame.frame });
  const original = assetUrlOver(transport, asset);
  return (
    <span
      title={`${frame.step}. ${frame.title}${frame.error ? `\n${frame.error}` : ""}`}
      className={
        frame.error !== undefined
          ? "rounded-md ring-2 ring-destructive"
          : undefined
      }
    >
      <AssetThumbnail
        size="chip"
        // A frame is an image the recorder wrote on the computer's disk.
        asset={asset}
        image={{
          name: `${frame.step}/${run.steps} · ${frame.title}`,
          sourceLabel: source,
          // The host's resized copy (cached for the file's version): a
          // thumbnail never downloads and decodes the full-size frame.
          // Offered only where a URL reaches the host's files at all.
          ...(original.kind === "ready"
            ? {
                resized: (edge: number) => {
                  const copy = assetUrlOver(
                    transport,
                    computerResizedAsset(frame.frame, edge, frame.version),
                  );
                  return copy.kind === "ready" ? copy.url : original.url;
                },
              }
            : {}),
        }}
      />
    </span>
  );
}
