import { Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import {
  DrawCanvas,
  applyStrokes,
  type Stroke,
} from "@plugins/screenshot/plugins/draw-canvas/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { attachmentBytes } from "@plugins/infra/plugins/attachments/core";
import { extractAttachmentIds } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/core";
import { useKept } from "@plugins/primitives/plugins/kept-state/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  screenshotCapture,
  screenshotEdits,
  screenshotTools,
  type ScreenshotEdit,
  type ScreenshotTools,
} from "../kept";
import { ToolsPane, type Tool, type DrawSettings } from "./tools-pane";
import { CropOverlay, type CropRect } from "./crop-overlay";
import { PromptForm } from "./prompt-form";

/**
 * How long a screenshot whose capture is not recorded yet reads as "still
 * uploading". The capturing tab opens this one before its upload lands, so a
 * short wait is normal; past this, the id names nothing (never uploaded, or
 * its record expired). Only the copy changes: the record is read live, so a
 * late upload still shows.
 */
const UPLOAD_GRACE_MS = 30_000;

const DEFAULT_TOOLS: ScreenshotTools = {
  tool: "none",
  color: "#ef4444",
  width: 4,
};

const NO_EDITS: { edits: ScreenshotEdit[]; strokes: Stroke[] } = {
  edits: [],
  strokes: [],
};

/**
 * The screenshot editor. Everything a reload must give back is kept
 * (`../kept`): the capture (a staged attachment, by id), the committed edits
 * and the strokes not applied yet (work), the tool and pen (view). The image
 * shown is DERIVED — the capture with its edits replayed — never held.
 */
export function ScreenshotView({ id }: { id: string }) {
  // The capture handed over by the capturing tab (BroadcastChannel) before
  // its upload lands — paints at once. A transient copy only: the staged
  // attachment recorded in `screenshotCapture` is the one a reload reads.
  // eslint-disable-next-line kept-state/no-blob-in-state -- transient handoff; the staged attachment (kept) is the durable copy
  const [broadcast, setBroadcast] = useState<Blob | null>(null);
  const [uploadOverdue, setUploadOverdue] = useState(false);
  const [capture] = useKept(screenshotCapture, null, { subject: id });
  const [work, setWork] = useKept(screenshotEdits, NO_EDITS, { subject: id });
  const [tools, setTools] = useKept(screenshotTools, DEFAULT_TOOLS);
  const { edits, strokes } = work;
  const tool = tools.tool;
  const setTool = (next: Tool) => setTools((t) => ({ ...t, tool: next }));
  const setStrokes = (next: Stroke[] | ((prev: Stroke[]) => Stroke[])) =>
    setWork((w) => ({
      ...w,
      strokes: typeof next === "function" ? next(w.strokes) : next,
    }));
  /** Commits the pending strokes (then `then`, if any) as edits. */
  const commit = (then?: ScreenshotEdit) => {
    setWork((w) => ({
      edits: [
        ...w.edits,
        ...(w.strokes.length > 0
          ? [{ kind: "draw" as const, strokes: w.strokes }]
          : []),
        ...(then ? [then] : []),
      ],
      strokes: [],
    }));
    setTool("none");
  };

  // The staged attachment, once the capturing tab recorded it.
  const attachmentId =
    capture === null ? null : (extractAttachmentIds(capture.image)[0] ?? null);
  const stored = useLive(
    attachmentBytes,
    broadcast === null && attachmentId !== null ? { id: attachmentId } : null,
  );
  // The stored bytes — a failed re-read keeps the copy it last read (the
  // read's `stale`) — as one Blob per bytes value: a re-emitted read of the
  // same bytes must not mint a new image (the edited image is derived from
  // it, and re-deriving remounts the stage, cutting a stroke in progress).
  const storedBytes = foldResource(stored, {
    loading: () => null,
    error: (_error, stale) => stale ?? null,
    ready: (bytes) => bytes,
  });
  const storedBlob = useMemo(
    () =>
      storedBytes === null
        ? null
        : new Blob([storedBytes], { type: "image/png" }),
    [storedBytes],
  );

  // Fast path: the capturing tab broadcasts the blob the instant domToBlob
  // finishes — no server round trip. The "ready" ping makes it re-send when it
  // broadcast before this listener was up. Not listened for once the capture
  // is recorded: a reload reads the attachment.
  const recorded = attachmentId !== null;
  useEffect(() => {
    if (recorded) return;
    const ch = new BroadcastChannel(`screenshot:${id}`);
    ch.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Blob) {
        setBroadcast(e.data);
        ch.close();
      }
    };
    ch.postMessage("ready");
    return () => ch.close();
  }, [id, recorded]);

  useEffect(() => {
    const timer = setTimeout(() => setUploadOverdue(true), UPLOAD_GRACE_MS);
    return () => clearTimeout(timer);
  }, [id]);

  // The captured image: the broadcast copy, else the stored one.
  const source: Blob | null = broadcast ?? storedBlob;
  // The capture with its committed edits replayed — derived, never held.
  const edited = useMemo(
    () => (source === null ? null : renderEdits(source, edits)),
    [source, edits],
  );

  // The image the tools act on (copy, download, the prompt's attachment):
  // the edited image with the pending strokes baked in. Null while the
  // capture has not arrived — every tool then does nothing.
  async function finalBlob(): Promise<Blob | null> {
    if (edited === null) return null;
    const base = await edited;
    return strokes.length > 0 ? await applyStrokes(base, strokes) : base;
  }

  function stage(promise: Promise<Blob>) {
    return (
      <Suspense fallback={<Loading />}>
        <ResolvedStage
          promise={promise}
          tool={tool}
          onCropCommit={(rect) => commit({ kind: "crop", rect })}
          strokes={strokes}
          onStrokesChange={setStrokes}
          drawSettings={tools}
        />
      </Suspense>
    );
  }

  const missing = uploadOverdue ? (
    <Text as="div" variant="body" tone="muted">
      Screenshot not found
    </Text>
  ) : (
    <Loading />
  );

  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- full-surface split row that also clips (flex-row + overflow-hidden, no single primitive)
    <Stack gap="none" direction="row" className="h-full w-full overflow-hidden">
      {/* eslint-disable-next-line layout/no-adhoc-layout -- flexible column leaf of the split row (fills + clips its share) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <Clip fill>
          <Center className="relative h-full w-full bg-muted/40">
            {edited !== null
              ? stage(edited)
              : attachmentId === null
                ? missing
                : foldResource(stored, {
                    loading: () => <Loading />,
                    error: (error) =>
                      error.kind === "refused" && error.code === "missing" ? (
                        <Text as="div" variant="body" tone="muted">
                          Screenshot not found
                        </Text>
                      ) : (
                        <ResourceErrorInline
                          error={error}
                          refetch={stored.refetch}
                          variant="block"
                          subject="the screenshot"
                        />
                      ),
                    // Unreachable: a ready read makes `edited` non-null.
                    ready: () => <Loading />,
                  })}
          </Center>
        </Clip>
        <PromptForm id={id} getBlob={finalBlob} />
      </div>
      {/* eslint-disable-next-line layout/no-adhoc-layout -- rigid fixed-width sidebar leaf of the split row */}
      <div className="w-72 shrink-0 border-l bg-background">
        <ToolsPane
          tool={tool}
          onToolChange={setTool}
          drawSettings={tools}
          onDrawSettingsChange={(s) =>
            setTools((t) => ({ ...t, color: s.color, width: s.width }))
          }
          hasStrokes={strokes.length > 0}
          onApplyDraw={() => {
            if (strokes.length > 0) commit();
          }}
          onClearStrokes={() => setStrokes([])}
          onUndoStroke={() => setStrokes((s) => s.slice(0, -1))}
          onCopy={async () => {
            const blob = await finalBlob();
            if (!blob) return;
            await navigator.clipboard.write([
              new ClipboardItem({ "image/png": blob }),
            ]);
          }}
          onDownload={async () => {
            const blob = await finalBlob();
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `screenshot-${id}.png`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          onReset={() => {
            setWork(NO_EDITS);
            setTool("none");
          }}
        />
      </div>
    </Stack>
  );
}

/** The stage once the edited image is rendered (suspends until then). */
function ResolvedStage({
  promise,
  ...props
}: Omit<ImageStageProps, "blob"> & { promise: Promise<Blob> }) {
  return <ImageStage blob={use(promise)} {...props} />;
}

/** The capture with `edits` replayed in order: each a draw or a crop over the last. */
async function renderEdits(
  source: Blob,
  edits: readonly ScreenshotEdit[],
): Promise<Blob> {
  let image = source;
  for (const edit of edits)
    image =
      edit.kind === "draw"
        ? await applyStrokes(image, edit.strokes)
        : await applyCrop(image, edit.rect);
  return image;
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
