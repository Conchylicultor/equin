import { useState } from "react";
import { flushSync } from "react-dom";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useToast, type Toast } from "@plugins/shell/plugins/notifications/web";
import {
  EndpointError,
  useFetchEndpoint,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { createScreenshot } from "../../shared/endpoints";
import { captureApp } from "../capture";
import { symbol } from "@plugins/ui/plugins/icons/core";

const photoCameraIcon = symbol("photo-camera");

export function ScreenshotButton() {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    // flushSync + two rAFs: commit the disabled state and let it paint
    // before domToBlob blocks the main thread.
    flushSync(() => setBusy(true));
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    try {
      // Capture while the tab is still in the foreground.  Opening the
      // new tab first would background this tab, which causes Chrome to
      // pause SVG rasterization (the <img> load event that
      // modern-screenshot relies on never fires in a hidden tab).
      const blob = await captureApp();
      if (!blob) {
        toast({
          type: "screenshot",
          title: "Screenshot failed",
          description: "Capture returned no image",
          variant: "error",
        });
        return;
      }

      const id = crypto.randomUUID();

      // Open the tab after capture — typically < 2 s after the click,
      // well within Chrome's 5-second user-activation window.
      window.open(`/screenshot/${id}`, "_blank", "noopener");

      // Deliver blob directly via BroadcastChannel so the new tab
      // displays the screenshot without waiting for the server roundtrip.
      // Use request-response: broadcast immediately (fast tab) AND reply
      // to "ready" pings from tabs that load after the first broadcast.
      const ch = new BroadcastChannel(`screenshot:${id}`);
      ch.postMessage(blob);
      ch.onmessage = (e: MessageEvent) => {
        if (e.data === "ready") ch.postMessage(blob);
      };
      // Stop listening after the tab has had time to receive the blob.
      setTimeout(() => ch.close(), 15_000);

      void upload(fetchEndpoint, toast, id, blob);
    } catch (err) {
      toast({
        type: "screenshot",
        title: "Screenshot failed",
        description: (err as Error).message,
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <IconButton
      icon={photoCameraIcon}
      label="Screenshot"
      loading={busy}
      onClick={handleClick}
    />
  );
}

async function upload(
  fetchEndpoint: FetchEndpoint,
  toast: Toast,
  id: string,
  blob: Blob,
): Promise<void> {
  // Fire clipboard copy and server upload in parallel. A clipboard permission
  // prompt must not block the upload — otherwise the just-opened tab sits on
  // "Loading…" until the user dismisses it.
  void navigator.clipboard
    .write([new ClipboardItem({ "image/png": blob })])
    .catch((err) => {
      // Clipboard permission denied or not supported — non-fatal; upload proceeds regardless.
      if (
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "SecurityError")
      )
        return;
      throw err;
    });

  try {
    await fetchEndpoint(createScreenshot, { id }, { body: blob });
  } catch (err) {
    if (err instanceof EndpointError) {
      toast({
        type: "screenshot",
        title: "Screenshot upload failed",
        description: `Server responded ${err.status}`,
        variant: "error",
      });
    } else {
      toast({
        type: "screenshot",
        title: "Screenshot upload failed",
        description: (err as Error).message,
        variant: "error",
      });
    }
  }
}
