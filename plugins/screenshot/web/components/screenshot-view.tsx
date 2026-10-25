import { useEffect, useMemo, useRef, useState } from "react";
import {
  DrawCanvas,
  applyStrokes,
  type Stroke,
} from "@plugins/screenshot/plugins/draw-canvas/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  mapResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { screenshotImage } from "../../shared/image";
import { ToolsPane, type Tool, type DrawSettings } from "./tools-pane";
import { CropOverlay, type CropRect } from "./crop-overlay";
import { PromptForm } from "./prompt-form";

/**
 * How long a `missing` screenshot reads as "still uploading" before the pane
 * says it is not there. The capturing tab opens this one before its upload
 * lands, so a short wait is normal; past this, the id names nothing (expired,
 * or lost to a server restart). Only the copy changes: the read stays live, so
 * a late upload still shows.
 */
const UPLOAD_GRACE_MS = 30_000;

export function ScreenshotView({ id }: { id: string }) {
  // The capture handed over by the capturing tab (BroadcastChannel), when it
  // arrives before the server's copy.
  const [broadcast, setBroadcast] = useState<Blob | null>(null);
  // The image after a committed crop / applied drawing; null = the original.
  const [edited, setEdited] = useState<Blob | null>(null);
  const [uploadOverdue, setUploadOverdue] = useState(false);
  const [tool, setTool] = useState<Tool>("none");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [draw, setDraw] = useState<DrawSettings>({
    color: "#ef4444",
    width: 4,
  });

  function resetEdits() {
    setTool("none");
    setStrokes([]);
  }

  // The server's copy, live: refused `missing` until the capturing tab's
  // upload lands, which notifies this tuple. Not read once the broadcast
  // delivered the same image.
  const stored = useLive(screenshotImage, broadcast === null ? { id } : null);
  const storedBlob = useMemo(
    () =>
      mapResource(stored, (bytes) => new Blob([bytes], { type: "image/png" })),
    [stored],
  );
  const storedReady = stored.status === "ready";

  // Fast path: the capturing tab broadcasts the blob the instant domToBlob
  // finishes — no server round trip. The "ready" ping makes it re-send when it
  // broadcast before this listener was up. Whichever copy lands first wins:
  // the channel closes once the server's copy is here.
  useEffect(() => {
    if (storedReady) return;
    const ch = new BroadcastChannel(`screenshot:${id}`);
    ch.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Blob) {
        setBroadcast(e.data);
        ch.close();
      }
    };
    ch.postMessage("ready");
    return () => ch.close();
  }, [id, storedReady]);

  useEffect(() => {
    const timer = setTimeout(() => setUploadOverdue(true), UPLOAD_GRACE_MS);
    return () => clearTimeout(timer);
  }, [id]);

  // The image the tools act on (copy, download, apply, the prompt's
  // attachment): the edit, else whichever original copy is here. Absent while
  // neither has arrived — every tool then does nothing.
  // A failed re-read (the server lost the image to a restart) keeps the copy
  // it last read: the read's `stale`, drawn and acted on as before.
  const shown = edited ?? broadcast;
  const imageBlob: Blob | null =
    shown ??
    foldResource(storedBlob, {
      loading: () => null,
      error: (_error, stale) => stale ?? null,
      ready: (blob) => blob,
    });

  function stage(blob: Blob) {
    return (
      <ImageStage
        blob={blob}
        tool={tool}
        onCropCommit={async (rect) => {
          const base =
            strokes.length > 0 ? await applyStrokes(blob, strokes) : blob;
          setEdited(await applyCrop(base, rect));
          resetEdits();
        }}
        strokes={strokes}
        onStrokesChange={setStrokes}
        drawSettings={draw}
      />
    );
  }

  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- full-surface split row that also clips (flex-row + overflow-hidden, no single primitive)
    <Stack gap="none" direction="row" className="h-full w-full overflow-hidden">
      {/* eslint-disable-next-line layout/no-adhoc-layout -- flexible column leaf of the split row (fills + clips its share) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <Clip fill>
          <Center className="relative h-full w-full bg-muted/40">
            {shown !== null
              ? stage(shown)
              : foldResource(storedBlob, {
                  loading: () => <Loading />,
                  error: (error, stale) =>
                    stale !== undefined ? (
                      stage(stale)
                    ) : error.kind === "refused" && error.code === "missing" ? (
                      uploadOverdue ? (
                        <Text as="div" variant="body" tone="muted">
                          Screenshot not found
                        </Text>
                      ) : (
                        <Loading />
                      )
                    ) : (
                      <ResourceErrorInline
                        error={error}
                        refetch={stored.refetch}
                        variant="block"
                        subject="the screenshot"
                      />
                    ),
                  ready: stage,
                })}
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
            setEdited(await applyStrokes(imageBlob, strokes));
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
            setEdited(null);
            resetEdits();
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
