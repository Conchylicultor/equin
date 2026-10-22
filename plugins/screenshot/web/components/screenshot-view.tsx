import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DrawCanvas,
  applyStrokes,
  type Stroke,
} from "@plugins/screenshot/plugins/draw-canvas/web";
import {
  EndpointError,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { getScreenshot } from "../../shared/endpoints";
import { ToolsPane, type Tool, type DrawSettings } from "./tools-pane";
import { CropOverlay, type CropRect } from "./crop-overlay";
import { PromptForm } from "./prompt-form";

export function ScreenshotView({ id }: { id: string }) {
  const fetchEndpoint = useFetchEndpoint();
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("none");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [draw, setDraw] = useState<DrawSettings>({
    color: "#ef4444",
    width: 4,
  });
  // Set to true once the blob is delivered (either via BroadcastChannel or
  // server poll) so the other path knows to bail out.
  const blobDelivered = useRef(false);

  function resetEdits() {
    setTool("none");
    setStrokes([]);
  }

  // Primary delivery: BroadcastChannel receives the blob directly from the
  // capturing tab the instant domToBlob finishes — no server roundtrip.
  // Send a "ready" ping so the original tab replies even if it finished
  // broadcasting before this tab's listener was set up.
  useEffect(() => {
    const ch = new BroadcastChannel(`screenshot:${id}`);
    ch.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Blob) {
        blobDelivered.current = true;
        setImageBlob(e.data);
        resetEdits();
        ch.close();
      }
    };
    ch.postMessage("ready");
    return () => ch.close();
  }, [id]);

  // Fallback delivery: server poll handles page refreshes and cases where the
  // BroadcastChannel message was missed (tab not yet listening when sent).
  const reload = useCallback(async () => {
    setError(null);
    const deadline = Date.now() + 30_000;
    while (true) {
      if (blobDelivered.current) return;
      try {
        const blob = await fetchEndpoint(getScreenshot, { id });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!blobDelivered.current) {
          setImageBlob(blob);
          resetEdits();
        }
        return;
      } catch (err) {
        // A 404 means the screenshot has not been uploaded yet — keep polling
        // until the deadline. Any other error (or a 404 past the deadline) is
        // terminal.
        if (
          err instanceof EndpointError &&
          err.status === 404 &&
          Date.now() <= deadline
        ) {
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!blobDelivered.current) {
          setError(
            err instanceof EndpointError && err.status === 404
              ? "Screenshot not found"
              : err instanceof EndpointError
                ? `Failed (${err.status})`
                : (err as Error).message,
          );
        }
        return;
      }
    }
  }, [fetchEndpoint, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- poll-on-mount: reload() is a self-contained 30s poll-with-retry (BroadcastChannel-raced, 404-backoff) that writes imageBlob/error; no data-fetching primitive (useEndpoint/useResource) covers this retry-loop pattern, and the fetch must be kicked off on mount/reload
    void reload();
  }, [reload]);

  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- full-surface split row that also clips (flex-row + overflow-hidden, no single primitive)
    <Stack gap="none" direction="row" className="h-full w-full overflow-hidden">
      {/* eslint-disable-next-line layout/no-adhoc-layout -- flexible column leaf of the split row (fills + clips its share) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <Clip fill>
          <Center className="relative h-full w-full bg-muted/40">
            {error ? (
              <Text as="div" variant="body" tone="muted">
                {error}
              </Text>
            ) : !imageBlob ? (
              <Loading />
            ) : (
              <ImageStage
                blob={imageBlob}
                tool={tool}
                onCropCommit={async (rect) => {
                  const base =
                    strokes.length > 0
                      ? await applyStrokes(imageBlob, strokes)
                      : imageBlob;
                  const next = await applyCrop(base, rect);
                  setImageBlob(next);
                  resetEdits();
                }}
                strokes={strokes}
                onStrokesChange={setStrokes}
                drawSettings={draw}
              />
            )}
          </Center>
        </Clip>
        <PromptForm
          id={id}
          getBlob={async () => {
            if (!imageBlob) return null;
            return strokes.length > 0
              ? await applyStrokes(imageBlob, strokes)
              : imageBlob;
          }}
        />
      </div>
      {/* eslint-disable-next-line layout/no-adhoc-layout -- rigid fixed-width sidebar leaf of the split row */}
      <div className="w-72 shrink-0 border-l bg-background">
        <ToolsPane
          tool={tool}
          onToolChange={setTool}
          drawSettings={draw}
          onDrawSettingsChange={setDraw}
          hasStrokes={strokes.length > 0}
          onApplyDraw={async () => {
            if (!imageBlob || strokes.length === 0) return;
            const next = await applyStrokes(imageBlob, strokes);
            setImageBlob(next);
            resetEdits();
          }}
          onClearStrokes={() => setStrokes([])}
          onUndoStroke={() => setStrokes((s) => s.slice(0, -1))}
          onCopy={async () => {
            if (!imageBlob) return;
            const blob =
              strokes.length > 0
                ? await applyStrokes(imageBlob, strokes)
                : imageBlob;
            await navigator.clipboard.write([
              new ClipboardItem({ "image/png": blob }),
            ]);
          }}
          onDownload={async () => {
            if (!imageBlob) return;
            const blob =
              strokes.length > 0
                ? await applyStrokes(imageBlob, strokes)
                : imageBlob;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `screenshot-${id}.png`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          onReset={() => {
            blobDelivered.current = false;
            void reload();
          }}
        />
      </div>
    </Stack>
  );
}

interface ImageStageProps {
  blob: Blob;
  tool: Tool;
  onCropCommit: (r: CropRect) => void;
  strokes: Stroke[];
  onStrokesChange: (s: Stroke[] | ((prev: Stroke[]) => Stroke[])) => void;
  drawSettings: DrawSettings;
}

function ImageStage({
  blob,
  tool,
  onCropCommit,
  strokes,
  onStrokesChange,
  drawSettings,
}: ImageStageProps) {
  // Derive the object URL in render so it exists on the first paint (no extra
  // null→url render cycle); a cleanup-only effect revokes it when it changes.
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  const [naturalSize, setNaturalSize] = useState<{
    w: number;
    h: number;
  } | null>(null);
  const [displayedRect, setDisplayedRect] = useState<DOMRect | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  // Track the rendered image rectangle (for mapping pointer events to image px).
  // Observes both the container and the image; no-ops until both are mounted.
  useResizeObserver(
    [containerRef, imgRef],
    () => {
      const img = imgRef.current;
      const container = containerRef.current;
      if (!img || !container) return;
      const containerRect = container.getBoundingClientRect();
      const imgRect = img.getBoundingClientRect();
      // Express relative to the container so overlay positioning is local.
      setDisplayedRect(
        new DOMRect(
          imgRect.left - containerRect.left,
          imgRect.top - containerRect.top,
          imgRect.width,
          imgRect.height,
        ),
      );
    },
    { deps: [url, naturalSize] },
  );

  return (
    <Center as="div" ref={containerRef} className="relative h-full w-full p-lg">
      <img
        ref={imgRef}
        src={url}
        alt="Screenshot"
        draggable={false}
        className="max-h-full max-w-full object-contain shadow-lg"
        onLoad={(e) => {
          const t = e.currentTarget;
          setNaturalSize({ w: t.naturalWidth, h: t.naturalHeight });
        }}
      />
      {tool === "crop" && naturalSize && displayedRect && (
        <CropOverlay
          displayed={displayedRect}
          natural={naturalSize}
          onCommit={onCropCommit}
        />
      )}
      {(tool === "draw" || strokes.length > 0) &&
        naturalSize &&
        displayedRect && (
          <DrawCanvas
            displayed={displayedRect}
            natural={naturalSize}
            strokes={strokes}
            onStrokesChange={onStrokesChange}
            color={drawSettings.color}
            width={drawSettings.width}
            readOnly={tool !== "draw"}
          />
        )}
    </Center>
  );
}

async function applyCrop(blob: Blob, crop: CropRect): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.w));
  canvas.height = Math.max(1, Math.round(crop.h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(
    img,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
}
