import { useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { useDraft } from "@plugins/primitives/plugins/kept-state/web";
import { captureApp } from "@plugins/screenshot/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { uploadAttachment } from "@plugins/infra/plugins/attachments/web";
import { attachmentMarkdown } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { insertIntoWishDraft } from "@plugins/wish/web";
import type { Stroke } from "@plugins/screenshot/plugins/draw-canvas/web";
import { LiveDrawOverlay } from "./live-draw-overlay";
import { symbol } from "@plugins/ui/plugins/icons/core";

const gestureIcon = symbol("gesture");

/**
 * The drawing over this browser tab (kept-state work): whether the overlay is
 * up, its strokes and pen — so a reload or an upgrade of the tab gives the
 * half-made drawing back. Session area: a drawing belongs to the tab it was
 * drawn over, never to another tab of the browser.
 */
const drawingStore = defineStore({
  owner: "screenshot.draw-on-app",
  label: "Drawings on the app",
  area: "session",
  cap: "256 KB",
  ttl: 7 * 24 * 60 * 60 * 1000,
  whenFull: "refuse",
  schema: z.object({
    active: z.boolean(),
    color: z.string(),
    width: z.number(),
    strokes: z.array(
      z.object({
        color: z.string(),
        width: z.number(),
        points: z.array(z.object({ x: z.number(), y: z.number() })),
      }),
    ),
  }),
});

const NO_DRAWING = {
  active: false,
  color: "#ef4444",
  width: 4,
  strokes: [] as Stroke[],
};

export function DrawOnAppButton() {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  const [drawing, setDrawing] = useDraft(drawingStore, NO_DRAWING);
  const { active, strokes, color, width } = drawing;
  const setActive = (next: boolean) =>
    setDrawing((d) => ({ ...d, active: next }));
  const setStrokes = (next: Stroke[] | ((prev: Stroke[]) => Stroke[])) =>
    setDrawing((d) => ({
      ...d,
      strokes: typeof next === "function" ? next(d.strokes) : next,
    }));
  const setColor = (next: string) => setDrawing((d) => ({ ...d, color: next }));
  const setWidth = (next: number) => setDrawing((d) => ({ ...d, width: next }));
  const [busy, setBusy] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);

  // The pen stays as picked; the drawing goes.
  const teardown = () => {
    setDrawing((d) => ({ ...d, active: false, strokes: [] }));
    setChromeVisible(true);
  };

  const onCancel = () => {
    if (busy) return;
    teardown();
  };

  const onDone = async () => {
    if (busy || strokes.length === 0) return;
    setBusy(true);
    try {
      flushSync(() => setChromeVisible(false));
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
      const blob = await captureApp(
        (node: Node) =>
          !(node instanceof HTMLElement && node.dataset.drawChrome === "true"),
      );
      if (!blob) {
        toast({
          type: "screenshot",
          category: "other",
          title: "Capture failed",
          description: "Capture returned no image",
          variant: "error",
        });
        setChromeVisible(true);
        return;
      }
      const uploaded = await uploadAttachment(
        fetchEndpoint,
        blob,
        "drawing.png",
        "image/png",
      );
      teardown();
      insertIntoWishDraft(attachmentMarkdown(uploaded.id, "drawing.png"));
    } catch (err) {
      toast({
        type: "screenshot",
        category: "other",
        title: "Capture failed",
        description: (err as Error).message,
        variant: "error",
      });
      setChromeVisible(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <IconButton
        icon={gestureIcon}
        label="Draw on app"
        disabled={active}
        onClick={() => setActive(true)}
      />
      {active && (
        <LiveDrawOverlay
          strokes={strokes}
          onStrokesChange={setStrokes}
          color={color}
          onColorChange={setColor}
          width={width}
          onWidthChange={setWidth}
          chromeVisible={chromeVisible}
          busy={busy}
          onDone={onDone}
          onCancel={onCancel}
        />
      )}
    </>
  );
}
