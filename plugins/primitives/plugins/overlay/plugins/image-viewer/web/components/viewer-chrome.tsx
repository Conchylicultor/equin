import {
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  Button,
  ControlSizeProvider,
  SURFACE_LEVELS,
  Separator,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { placedClasses } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import {
  Stack,
  selfClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Slider } from "@plugins/primitives/plugins/css/plugins/slider/web";
import {
  MAX_SCALE,
  STRIP_HEIGHT,
  TILE_MAX,
  TILE_MIN,
  VIEWER_GESTURES,
  VIEWER_KEYS,
  fitScale,
  isAtScale,
  isZoomed,
  minimapRect,
  overflows,
  type ImageCapabilities,
  type Size,
} from "../../core";
import type { ViewController } from "../internal/view-controller";
import { ViewStore, type ViewState } from "../internal/view-store";
import type { ViewerImage } from "../internal/types";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { originalHref } from "../internal/file-actions";
import { KeyCaps, keyTooltip } from "./key-caps";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const chevronLeftIcon = symbol("chevron-left");
const chevronRightIcon = symbol("chevron-right");
const closeIcon = symbol("close");
const contentCopyIcon = symbol("content-copy");
const downloadIcon = symbol("download");
const fitScreenIcon = symbol("fit-screen");
const gridIcon = symbol("grid-view");
const gridSmallIcon = symbol("grid-on");
const imageIcon = symbol("image");
const slideshowIcon = symbol("slideshow");
const stripIcon = symbol("view-carousel");
const keyboardIcon = symbol("keyboard");
const removeIcon = symbol("remove");

/**
 * A floating control group: the overlay surface, see-through over the image,
 * with the page blurred behind it. Reads `SURFACE_LEVELS.overlay` so it
 * re-themes with every other popover; only its fill is made translucent (the
 * same `--popover` tone, so the surface's `--hover-fill` still tells the truth
 * about what a ghost button hovers to).
 */
export const PANEL = cn(
  SURFACE_LEVELS.overlay,
  "bg-popover/80 backdrop-blur-md",
);

/**
 * Every control fades together: before the open settles, while closing, and
 * after a quiet spell while zoomed. `invisible` rides along with the opacity so
 * a faded control is neither clickable nor reachable by Tab (a hidden element
 * cannot take focus), and the visibility flip waits for the fade to finish.
 * Driven by the viewer root's `data-chrome`.
 */
const CHROME_FADE =
  "transition-[opacity,visibility] duration-200 group-data-[chrome=hidden]/viewer:invisible group-data-[chrome=hidden]/viewer:opacity-0";

/** Matches a control group (each carries `data-viewer-chrome`) under the
 *  pointer — the idle fade leaves the controls up while the pointer rests on
 *  one. */
export const HOVERED_CHROME = "[data-viewer-chrome]:hover";

/** The file actions and the counter, over the top edge. */
export function TopBar({
  image,
  index,
  count,
  capabilities,
  compact,
  onCopy,
  onDownload,
  onSlideshow,
  onClose,
}: {
  image: ViewerImage;
  index: number;
  count: number;
  capabilities: ImageCapabilities;
  compact: boolean;
  onCopy(): Promise<void>;
  onDownload(): void;
  onSlideshow(): void;
  onClose(): void;
}) {
  const natural = ViewStore.useSelector((s) => s.natural, []);
  const status = ViewStore.useSelector((s) => s.status, []);
  return (
    <Pin to="top" stretch offset="md" decorative className={CHROME_FADE}>
      <Stack gap="sm" align="center">
        <Line className={cn("gap-sm", selfClass("stretch"))}>
          <Line
            data-viewer-chrome
            className={cn(
              PANEL,
              "pointer-events-auto gap-sm px-md py-xs",
              yieldClass("x"),
            )}
          >
            {image.sourceLabel && <Badge>{image.sourceLabel}</Badge>}
            <Text variant="code">{image.name}</Text>
            {natural && !compact && (
              <Text variant="caption" tone="muted" className="tabular-nums">
                {natural.width} × {natural.height}
              </Text>
            )}
          </Line>
          <Fill />
          {/* One control group: where you are, what you can do with this
              image, then leaving it — read left to right. */}
          <Line
            data-viewer-chrome
            className={cn(PANEL, "pointer-events-auto gap-2xs p-2xs")}
          >
            {count > 1 && !compact && (
              <>
                <Text
                  variant="caption"
                  tone="muted"
                  className="px-sm tabular-nums"
                >
                  {index + 1} / {count}
                </Text>
                <Separator orientation="vertical" className="h-4" />
              </>
            )}
            {capabilities.open !== "none" && (
              <NewTabButton
                href={originalHref(image.src, capabilities.open)}
                label="Open original in a new tab"
              />
            )}
            {capabilities.copy && (
              <IconButton
                icon={contentCopyIcon}
                label="Copy image"
                tooltip={keyTooltip("Copy image", "copy")}
                disabled={natural === null}
                onClick={onCopy}
              />
            )}
            {capabilities.download && (
              <IconButton
                icon={downloadIcon}
                label="Download"
                onClick={onDownload}
              />
            )}
            {(capabilities.open !== "none" ||
              capabilities.copy ||
              capabilities.download) && (
              <Separator orientation="vertical" className="h-4" />
            )}
            <IconButton
              icon={slideshowIcon}
              label="Slideshow"
              tooltip={keyTooltip(
                "Slideshow — full screen, no controls",
                "slideshow",
              )}
              onClick={onSlideshow}
            />
            <IconButton
              icon={closeIcon}
              label="Close"
              tooltip={keyTooltip("Close", "close")}
              onClick={onClose}
            />
          </Line>
        </Line>
        {status !== null && (
          <Text
            variant="label"
            className={cn(PANEL, "rounded-full px-md py-xs")}
          >
            {status}
          </Text>
        )}
      </Stack>
    </Pin>
  );
}

/** The ‹ › arrows on the sides, when there is more than one image. */
export function NavArrows({
  index,
  count,
  lifted,
  onPrevious,
  onNext,
}: {
  index: number;
  count: number;
  /** The thumbnail strip is docked: centre on the room above it. */
  lifted: boolean;
  onPrevious(): void;
  onNext(): void;
}) {
  if (count < 2) return null;
  const lift = lifted ? { marginTop: -STRIP_HEIGHT / 2 } : undefined;
  // A spent arrow disappears instead of greying out: there is nothing on that
  // side, and a dimmed arrow would still read as a way to go.
  const arrow = cn(PANEL, "disabled:opacity-0");
  return (
    <ControlSizeProvider size="lg">
      <Pin
        to="left"
        offset="md"
        className={CHROME_FADE}
        style={lift}
        data-viewer-chrome
      >
        <IconButton
          icon={chevronLeftIcon}
          label="Previous image"
          tooltip={keyTooltip("Previous image", "previous")}
          shape="pill"
          className={arrow}
          disabled={index === 0}
          onClick={onPrevious}
        />
      </Pin>
      <Pin
        to="right"
        offset="md"
        className={CHROME_FADE}
        style={lift}
        data-viewer-chrome
      >
        <IconButton
          icon={chevronRightIcon}
          label="Next image"
          tooltip={keyTooltip("Next image", "next")}
          shape="pill"
          className={arrow}
          disabled={index === count - 1}
          onClick={onNext}
        />
      </Pin>
    </ControlSizeProvider>
  );
}

/** `fit` of the current state, once the sizes are known. */
function fitOf(s: ViewState): number | null {
  return s.natural && s.area ? fitScale(s.natural, s.area) : null;
}

const HINT = "Click to close · Scroll to zoom · Drag to pan";

/** The toolbar at the bottom: the view toggles (strip, grid) when there is
 *  more than one image, then − 62% + | Fit 1:1 — or, over the grid, the
 *  tile-size slider — then ⌨, with the shortcut sheet and the first-open hint
 *  stacked above it. Rides above the thumbnail strip when that is docked. */
export function BottomBar({
  ctl,
  count,
}: {
  ctl: ViewController;
  count: number;
}) {
  const hint = ViewStore.useSelector((s) => s.hint, []);
  const layout = ViewStore.useSelector((s) => s.layout, []);
  const strip = ViewStore.useSelector((s) => s.strip, []);
  const tile = ViewStore.useSelector((s) => s.tile, []);
  const grid = layout === "grid";
  const stripShown = strip && !grid && count > 1;
  const sheet = ViewStore.useSelector((s) => s.sheet, []);

  return (
    <Pin
      to="bottom"
      offset="lg"
      decorative
      className={cn(CHROME_FADE, "transition-[opacity,visibility,margin]")}
      style={stripShown ? { marginBottom: STRIP_HEIGHT } : undefined}
    >
      <Stack gap="sm" align="center">
        {sheet && <ShortcutSheet />}
        {hint && !grid && (
          <Text
            variant="label"
            className={cn(PANEL, "rounded-full px-md py-xs")}
          >
            {HINT}
          </Text>
        )}
        <Line
          data-viewer-chrome
          className={cn(PANEL, "pointer-events-auto gap-2xs p-2xs")}
        >
          {count > 1 && (
            <>
              <IconButton
                icon={stripIcon}
                label="Thumbnail strip"
                tooltip={keyTooltip("Thumbnail strip", "toggle-strip")}
                aria-pressed={stripShown}
                className="aria-pressed:bg-hover-fill"
                onClick={() => {
                  // From the grid the strip button means "one image, strip
                  // docked": it never undocks on the way out of the grid.
                  if (grid) {
                    ctl.setLayout("single");
                    ctl.setStrip(true);
                  } else ctl.setStrip(!strip);
                }}
              />
              <IconButton
                icon={gridIcon}
                label="Grid of every image"
                tooltip={keyTooltip("Grid of every image", "toggle-grid")}
                aria-pressed={grid}
                className="aria-pressed:bg-hover-fill"
                onClick={() => ctl.setLayout(grid ? "single" : "grid")}
              />
              <Separator orientation="vertical" className="h-4" />
            </>
          )}
          {grid ? (
            <>
              <IconButton
                icon={gridSmallIcon}
                label="Smaller thumbnails"
                tooltip={keyTooltip("Smaller thumbnails", "zoom-out")}
                disabled={tile <= TILE_MIN}
                onClick={() => ctl.stepTile(-1)}
              />
              <Slider
                value={tile}
                min={TILE_MIN}
                max={TILE_MAX}
                step={4}
                aria-label="Thumbnail size"
                className="w-28"
                onValueChange={(v) => ctl.setTile(v)}
              />
              <IconButton
                icon={imageIcon}
                label="Larger thumbnails"
                tooltip={keyTooltip("Larger thumbnails", "zoom-in")}
                disabled={tile >= TILE_MAX}
                onClick={() => ctl.stepTile(1)}
              />
            </>
          ) : (
            <ZoomControls ctl={ctl} />
          )}
          <Separator orientation="vertical" className="h-4" />
          <IconButton
            icon={keyboardIcon}
            label="Keyboard shortcuts"
            tooltip={keyTooltip("Keyboard shortcuts", "shortcuts")}
            aria-pressed={sheet}
            className="aria-pressed:bg-hover-fill"
            onClick={() => ctl.setSheet(!sheet)}
          />
        </Line>
      </Stack>
    </Pin>
  );
}

/** − 62% + | Fit 1:1 — the single image's zoom group. */
function ZoomControls({ ctl }: { ctl: ViewController }) {
  const percent = ViewStore.useSelector(
    (s) => Math.round(s.view.scale * 100),
    [],
  );
  const atFit = ViewStore.useSelector((s) => {
    const fit = fitOf(s);
    return fit !== null && isAtScale(s.view, fit);
  }, []);
  const atActual = ViewStore.useSelector((s) => isAtScale(s.view, 1), []);
  const canZoomOut = ViewStore.useSelector(
    (s) =>
      s.natural !== null &&
      s.area !== null &&
      isZoomed(s.view, s.natural, s.area),
    [],
  );
  const canZoomIn = ViewStore.useSelector(
    (s) => s.natural !== null && s.view.scale < MAX_SCALE - 1e-3,
    [],
  );
  return (
    <>
      <IconButton
        icon={removeIcon}
        label="Zoom out"
        tooltip={keyTooltip("Zoom out", "zoom-out")}
        disabled={!canZoomOut}
        onClick={() => ctl.step(-1)}
      />
      <Text variant="label" className="w-12 text-center tabular-nums">
        {percent}%
      </Text>
      <IconButton
        icon={addIcon}
        label="Zoom in"
        tooltip={keyTooltip("Zoom in", "zoom-in")}
        disabled={!canZoomIn}
        onClick={() => ctl.step(1)}
      />
      <Separator orientation="vertical" className="h-4" />
      <Button
        tooltip={keyTooltip("Fit to screen", "fit")}
        variant="ghost"
        aria-pressed={atFit}
        className="aria-pressed:bg-hover-fill"
        onClick={() => ctl.toFit(true)}
      >
        <Icon icon={fitScreenIcon} />
        Fit
      </Button>
      <Button
        tooltip={keyTooltip("Actual size", "actual-size")}
        variant="ghost"
        aria-pressed={atActual}
        className="tabular-nums aria-pressed:bg-hover-fill"
        onClick={() => ctl.actualSize()}
      >
        1:1
      </Button>
    </>
  );
}

/** One row of the sheet: its caps right-aligned in a fixed column, then what
 *  it does. */
function SheetRow({
  caps,
  description,
}: {
  caps: readonly string[];
  description: string;
}) {
  return (
    <Line className="gap-md">
      <Stack direction="row" gap="2xs" justify="end" className="w-20">
        <KeyCaps caps={caps} />
      </Stack>
      <Text variant="caption" tone="muted">
        {description}
      </Text>
    </Line>
  );
}

/** The `?` sheet: the pointer gestures, then every row of `VIEWER_KEYS`. */
function ShortcutSheet() {
  return (
    <Stack
      gap="xs"
      data-viewer-chrome
      className={cn(PANEL, "pointer-events-auto p-md")}
    >
      <Text variant="eyebrow" tone="muted">
        Shortcuts
      </Text>
      {VIEWER_GESTURES.map((g) => (
        <SheetRow key={g.cap} caps={[g.cap]} description={g.description} />
      ))}
      {VIEWER_KEYS.map((k) => (
        <SheetRow key={k.action} caps={k.caps} description={k.description} />
      ))}
    </Stack>
  );
}

function sameSize(a: Size | null, b: Size | null): boolean {
  return (
    a === b ||
    (a !== null && b !== null && a.width === b.width && a.height === b.height)
  );
}

/**
 * Where the screen is on the whole image, bottom-right, while the zoomed image
 * overflows the screen. Press or drag on it to move there.
 *
 * Its size re-renders only when it appears or the image changes; the marked
 * rectangle follows every pan and zoom through a direct store subscription,
 * like the image itself.
 */
export function Minimap({
  image,
  ctl,
  lifted,
}: {
  image: ViewerImage;
  ctl: ViewController;
  /** The thumbnail strip is docked: sit above it. */
  lifted: boolean;
}) {
  const store = ViewStore.useStoreApi();
  const size = ViewStore.useSelector(
    (s) =>
      s.natural &&
      s.area &&
      s.phase === "open" &&
      overflows(s.view, s.natural, s.area)
        ? minimapRect(s.view, s.natural, s.area).size
        : null,
    [],
    sameSize,
  );
  const markRef = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);

  useLayoutEffect(() => {
    function place() {
      const s = store.getState();
      const mark = markRef.current;
      if (!mark || !s.natural || !s.area) return;
      const r = minimapRect(s.view, s.natural, s.area).viewport;
      mark.style.left = `${r.left}px`;
      mark.style.top = `${r.top}px`;
      mark.style.width = `${r.width}px`;
      mark.style.height = `${r.height}px`;
    }
    place();
    return store.subscribe(place);
  }, [store, size]);

  if (!size) return null;

  function jump(e: ReactPointerEvent<HTMLElement>) {
    const s = store.getState();
    if (!s.natural || !s.area) return;
    const k = minimapRect(s.view, s.natural, s.area).factor;
    const box = e.currentTarget.getBoundingClientRect();
    ctl.centerOn((e.clientX - box.left) / k, (e.clientY - box.top) / k);
  }

  return (
    <Pin
      to="bottom-right"
      offset="lg"
      className={CHROME_FADE}
      style={lifted ? { marginBottom: STRIP_HEIGHT } : undefined}
      data-viewer-chrome
    >
      <Clip
        className="relative cursor-crosshair touch-none rounded-md border border-border bg-background/40 shadow-lg"
        style={{ width: size.width, height: size.height }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pressed.current = true;
          jump(e);
        }}
        onPointerMove={(e) => {
          if (pressed.current) jump(e);
        }}
        onPointerUp={() => {
          pressed.current = false;
        }}
        onPointerCancel={() => {
          pressed.current = false;
        }}
      >
        <img
          src={image.src}
          alt=""
          draggable={false}
          className="pointer-events-none block size-full opacity-75"
        />
        {/* The marked part, with the rest of the minimap dimmed by a spread
            shadow the Clip crops at its edge. */}
        <div
          ref={markRef}
          className={cn(
            placedClasses({ decorative: true }),
            "rounded-sm border border-foreground shadow-[0_0_0_999px_rgb(0_0_0/0.45)]",
          )}
        />
      </Clip>
    </Pin>
  );
}
