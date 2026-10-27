import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  ENGINE_WS_PATH,
  HostEventSchema,
  type ClientMessage,
  type EngineViewport,
} from "@plugins/apps/plugins/browser/plugins/engine/core";
import {
  useBrowserRemote,
  useBrowserTabs,
  type BrowserNavCommand,
  type BrowserTab,
} from "@plugins/apps/plugins/browser/plugins/shell/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Overlay,
  OverlayInteractive,
} from "@plugins/primitives/plugins/css/plugins/overlay/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useReconnectingWebSocket } from "@plugins/primitives/plugins/networking/web";
import type { CursorAnchor } from "@plugins/primitives/plugins/overlay/plugins/cursor-menu/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  heldButtonOf,
  keyMessage,
  modifiersOf,
  mouseButtonOf,
  routeKeyDown,
  wheelPixels,
} from "../input-map";
import { FramePainter } from "../internal/frame-painter";
import { UploadSender } from "../internal/upload-sender";
import {
  FileChooserPrompt,
  type FileChooserEvent,
  type UploadProgress,
} from "./file-chooser";
import { LatencyProbe } from "../internal/latency-probe";
import { PageDialog, type PageDialogEvent } from "./page-dialog";
import { SelectMenu, type PageSelectEvent } from "./select-menu";

/** Whether keys get macOS editing commands (the client stands in for the host's platform). */
const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

function commandMessage(cmd: BrowserNavCommand): ClientMessage {
  return cmd.kind === "navigate"
    ? { t: "navigate", url: cmd.url }
    : { t: cmd.kind };
}

/** The canvas's CSS box + the device pixel ratio frames render at. */
function viewportOf(canvas: HTMLCanvasElement): EngineViewport {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    dpr: window.devicePixelRatio || 1,
  };
}

/**
 * One tab's remote page, live: the engine socket (attach, the tab's pending
 * navigation requests, input out; frames and host events in), the canvas the
 * frames paint on, and a visually-hidden textarea that holds keyboard focus
 * (keys, IME composition, paste). Mounted only for the active tab showing a
 * page; unmounting closes the socket and the host stops streaming — the
 * remote page itself stays alive. Another window attaching to the same page
 * displaces this one (one viewer per page): it then offers to show it here.
 */
export function RemoteTab({ tab }: { tab: BrowserTab }) {
  // Bumped by "Show here": a fresh socket, which attaches again.
  const [attachment, setAttachment] = useState(0);
  const [displaced, setDisplaced] = useState(false);
  if (displaced) {
    return (
      <Displaced
        onShowHere={() => {
          setDisplaced(false);
          setAttachment((n) => n + 1);
        }}
      />
    );
  }
  return (
    <AttachedTab
      key={attachment}
      tab={tab}
      onDisplaced={() => setDisplaced(true)}
    />
  );
}

function AttachedTab({
  tab,
  onDisplaced,
}: {
  tab: BrowserTab;
  onDisplaced(): void;
}) {
  const { markAttached, markSent, report } = useBrowserRemote();
  const { open: openTab } = useBrowserTabs();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const painterRef = useRef<FramePainter | null>(null);
  const probeRef = useRef(new LatencyProbe());
  const tabRef = useLatestRef(tab);
  const composingRef = useRef(false);
  const pendingMoveRef = useRef<ClientMessage | null>(null);
  const moveRafRef = useRef<number | null>(null);
  // Which host question is still unanswered: a menu/dialog can report both a
  // pick and its own closing in one tick, and the host takes one answer.
  const pendingAnswerRef = useRef<"dialog" | "select" | null>(null);

  const [socketOpen, setSocketOpen] = useState(false);
  const [cursor, setCursor] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PageDialogEvent | null>(null);
  const [select, setSelect] = useState<{
    event: PageSelectEvent;
    anchor: CursorAnchor;
  } | null>(null);
  const [chooser, setChooser] = useState<{
    event: FileChooserEvent;
    progress: UploadProgress | null;
  } | null>(null);
  const uploadRef = useRef<UploadSender | null>(null);

  const ws = useReconnectingWebSocket({
    path: ENGINE_WS_PATH,
    binaryType: "arraybuffer",
    onOpen(socket) {
      const canvas = canvasRef.current;
      if (!canvas)
        throw new Error("RemoteTab: socket opened before its canvas mounted");
      const { id, key, url } = tabRef.current;
      const attach: ClientMessage = {
        t: "attach",
        key,
        url,
        viewport: viewportOf(canvas),
      };
      socket.send(JSON.stringify(attach));
      // An upload the old socket carried died with it; the host asks again
      // (a still-pending chooser is resent on attach).
      uploadRef.current = null;
      setChooser(null);
      markAttached(id, url);
      setSocketOpen(true);
    },
    onStatusChange(status) {
      if (status !== "open") setSocketOpen(false);
    },
    onMessage(ev) {
      if (ev.data instanceof ArrayBuffer) {
        probeRef.current.frameReceived();
        painterRef.current?.push(ev.data);
        return;
      }
      if (typeof ev.data !== "string") {
        throw new Error(
          `RemoteTab: unexpected engine message ${String(ev.data)}`,
        );
      }
      const event = HostEventSchema.parse(JSON.parse(ev.data));
      switch (event.t) {
        case "state":
          setError(null);
          report(tabRef.current.id, event.state);
          break;
        case "cursor":
          setCursor(event.value);
          break;
        case "copied":
          void navigator.clipboard.writeText(event.text);
          break;
        case "dialog":
          pendingAnswerRef.current = "dialog";
          setDialog(event);
          break;
        case "select": {
          const canvas = canvasRef.current;
          if (!canvas) break;
          const box = canvas.getBoundingClientRect();
          pendingAnswerRef.current = "select";
          setSelect({
            event,
            anchor: {
              x: box.left + event.rect.x,
              y: box.top + event.rect.y + event.rect.height,
            },
          });
          break;
        }
        case "popup":
          openTab(event.url, { key: event.key });
          break;
        case "download":
          showToast({
            title: `Downloaded ${event.name}`,
            description: event.path,
          });
          break;
        case "error":
          // A failed upload is over: its acks stop.
          if (uploadRef.current) {
            uploadRef.current = null;
            setChooser(null);
          }
          setError(event.message);
          break;
        case "fileChooser":
          uploadRef.current = null;
          setChooser({ event, progress: null });
          break;
        case "upload": {
          const upload = uploadRef.current;
          if (!upload) break;
          if (event.received >= event.total) {
            uploadRef.current = null;
            setChooser(null);
            break;
          }
          upload.onAck();
          setChooser((c) =>
            c
              ? {
                  ...c,
                  progress: { received: event.received, total: event.total },
                }
              : c,
          );
          break;
        }
        case "displaced":
          onDisplaced();
          break;
      }
    },
  });

  const send = (msg: ClientMessage) => ws.current?.send(JSON.stringify(msg));

  // Deliver the tab's pending navigation request once attached.
  const { request, sentSeq } = tab;
  useEffect(() => {
    if (!socketOpen || !request || request.seq <= sentSeq) return;
    ws.current?.send(JSON.stringify(commandMessage(request.cmd)));
    markSent(tab.id, request.seq);
  }, [socketOpen, request, sentSeq, tab.id, markSent, ws]);

  // The painter lives with the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const painter = new FramePainter(canvas);
    painterRef.current = painter;
    return () => {
      painter.dispose();
      painterRef.current = null;
    };
  }, []);

  // The canvas's backing store tracks its CSS box × dpr; the host's viewport
  // follows (RAF-debounced by useResizeObserver).
  useResizeObserver(
    canvasRef,
    () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const viewport = viewportOf(canvas);
      const width = Math.round(viewport.width * viewport.dpr);
      const height = Math.round(viewport.height * viewport.dpr);
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      painterRef.current?.repaint();
      if (socketOpen) send({ t: "resize", viewport });
    },
    { deps: [socketOpen] },
  );

  // Wheel needs a non-passive listener to keep the app from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = canvas.getBoundingClientRect();
      ws.current?.send(
        JSON.stringify({
          t: "wheel",
          x: e.clientX - box.left,
          y: e.clientY - box.top,
          deltaX: wheelPixels(e.deltaX, e.deltaMode, box.width),
          deltaY: wheelPixels(e.deltaY, e.deltaMode, box.height),
          modifiers: modifiersOf(e),
        } satisfies ClientMessage),
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [ws]);

  useEffect(
    () => () => {
      if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current);
    },
    [],
  );

  const mouseMessage = (
    e: MouseEvent<HTMLCanvasElement>,
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
  ): ClientMessage => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      t: "mouse",
      type,
      x: e.clientX - box.left,
      y: e.clientY - box.top,
      button:
        type === "mouseMoved"
          ? heldButtonOf(e.buttons)
          : mouseButtonOf(e.button),
      buttons: e.buttons,
      clickCount: type === "mouseMoved" ? 0 : e.detail,
      modifiers: modifiersOf(e),
    };
  };

  /** Send a coalesced move now, so it precedes the press/release that follows. */
  const flushMove = () => {
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    const move = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (move) send(move);
  };

  const clearInput = () => {
    if (inputRef.current) inputRef.current.value = "";
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    // Drags that leave the canvas keep reporting to it (mouse events follow
    // pointer capture).
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onMouseDown = (e: MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    inputRef.current?.focus({ preventScroll: true });
    flushMove();
    send(mouseMessage(e, "mousePressed"));
    probeRef.current.inputSent();
  };

  const onMouseUp = (e: MouseEvent<HTMLCanvasElement>) => {
    flushMove();
    send(mouseMessage(e, "mouseReleased"));
  };

  const onMouseMove = (e: MouseEvent<HTMLCanvasElement>) => {
    pendingMoveRef.current = mouseMessage(e, "mouseMoved");
    moveRafRef.current ??= requestAnimationFrame(() => {
      moveRafRef.current = null;
      flushMove();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keys of an IME composition are the composition's (→ `ime`).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const route = routeKeyDown(e, IS_MAC);
    if (route === "paste") return; // the `paste` event carries the text
    if (route === "copy") {
      // Read the selection before a cut's key removes it.
      send({ t: "copy" });
      send(keyMessage(e, "down", IS_MAC));
      return;
    }
    if (route === "forward") e.preventDefault();
    send(keyMessage(e, "down", IS_MAC));
  };

  const onKeyUp = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (routeKeyDown(e, IS_MAC) === "paste") return;
    send(keyMessage(e, "up", IS_MAC));
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text !== "") send({ t: "insertText", text });
  };

  const onComposition = (e: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = true;
    send({
      t: "ime",
      text: e.data,
      selectionStart: e.data.length,
      selectionEnd: e.data.length,
    });
  };

  const onCompositionEnd = (e: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    send({ t: "insertText", text: e.data });
    clearInput();
  };

  // Text that arrives without a forwarded key (dictation, the emoji picker,
  // autocorrect) — typed keys are prevented, so they never land here.
  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    if (composingRef.current) return;
    const text = e.currentTarget.value;
    clearInput();
    if (text !== "") send({ t: "insertText", text });
  };

  const answerDialog = (accept: boolean, promptText?: string) => {
    if (pendingAnswerRef.current !== "dialog") return;
    pendingAnswerRef.current = null;
    setDialog(null);
    send({
      t: "dialog",
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
  };

  const pickFiles = (files: File[]) => {
    const socket = ws.current;
    if (!socket || !chooser) return;
    const upload = new UploadSender(files, (data) => socket.send(data));
    uploadRef.current = upload;
    const total = files.reduce((n, f) => n + f.size, 0);
    setChooser({ ...chooser, progress: { received: 0, total } });
    send(upload.announcement());
  };

  const cancelFiles = () => {
    setChooser(null);
    send({ t: "files", files: [] });
  };

  const answerSelect = (value: string | null) => {
    if (pendingAnswerRef.current !== "select") return;
    pendingAnswerRef.current = null;
    setSelect(null);
    send({ t: "select", value });
  };

  return (
    <Overlay
      fill
      className="h-full w-full"
      above={
        error !== null ? (
          <EngineError message={error} onDismiss={() => setError(null)} />
        ) : undefined
      }
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onContextMenu={(e) => e.preventDefault()}
      />
      <textarea
        ref={inputRef}
        aria-label="Page keyboard input"
        className="sr-only"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        onCompositionStart={onComposition}
        onCompositionUpdate={onComposition}
        onCompositionEnd={onCompositionEnd}
        onInput={onInput}
      />
      {dialog && (
        <PageDialog
          key={`${dialog.type}:${dialog.message}`}
          dialog={dialog}
          onAnswer={answerDialog}
        />
      )}
      {chooser && (
        <FileChooserPrompt
          chooser={chooser.event}
          progress={chooser.progress}
          onPick={pickFiles}
          onCancel={cancelFiles}
        />
      )}
      {select && (
        <SelectMenu
          select={select.event}
          anchor={select.anchor}
          onPick={answerSelect}
        />
      )}
    </Overlay>
  );
}

/** Another window shows this tab's page now; it streams to one viewer at a time. */
function Displaced({ onShowHere }: { onShowHere(): void }) {
  return (
    <Center axis="both" className="h-full w-full">
      <Stack direction="col" gap="sm" align="center" className="text-center">
        <Text variant="subheading">This tab is open in another window</Text>
        <Text variant="body" tone="muted">
          A page streams to one window at a time.
        </Text>
        <Button variant="outline" onClick={onShowHere}>
          Show it here
        </Button>
      </Stack>
    </Center>
  );
}

/** The host's error for this page, over the canvas until the next state or dismissal. */
function EngineError({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss(): void;
}) {
  return (
    <Center axis="both" className="h-full w-full">
      <OverlayInteractive>
        <Surface level="overlay" className="max-w-sm">
          <Inset pad="lg">
            <Stack
              direction="col"
              gap="sm"
              align="center"
              className="text-center"
            >
              <Text variant="subheading">The page hit an error</Text>
              <Text variant="body" tone="muted">
                {message}
              </Text>
              <Button variant="outline" onClick={onDismiss}>
                Dismiss
              </Button>
            </Stack>
          </Inset>
        </Surface>
      </OverlayInteractive>
    </Center>
  );
}
