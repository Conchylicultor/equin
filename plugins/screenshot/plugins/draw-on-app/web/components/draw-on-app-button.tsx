import { useState } from "react";
import { flushSync } from "react-dom";
import { captureApp } from "@plugins/screenshot/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { uploadAttachment } from "@plugins/infra/plugins/attachments/web";
import { attachmentMarkdown } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { insertIntoImproveDraft } from "@plugins/improve/web";
import type { Stroke } from "@plugins/screenshot/plugins/draw-canvas/web";
import { LiveDrawOverlay } from "./live-draw-overlay";
import { symbol } from "@plugins/ui/plugins/icons/core";

const gestureIcon = symbol("gesture");

export function DrawOnAppButton() {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  const [active, setActive] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState("#ef4444");
  const [width, setWidth] = useState(4);
  const [busy, setBusy] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);

  const teardown = () => {
    setActive(false);
    setStrokes([]);
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
      insertIntoImproveDraft(attachmentMarkdown(uploaded.id, "drawing.png"));
    } catch (err) {
      toast({
        type: "screenshot",
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
