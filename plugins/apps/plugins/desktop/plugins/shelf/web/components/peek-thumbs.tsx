import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { DesktopAppTile } from "@plugins/apps/plugins/desktop/plugins/shell/web";
import {
  setPeekedWindow,
  WindowSnapshot,
  type FloatingWindow,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";
import type { ActiveApp } from "@plugins/apps-core/web";

const closeIcon = symbol("close");
const addIcon = symbol("add");

/** The box a thumbnail's snapshot fits in (mockup `thumbFor`'s `max`). */
const THUMB_MAX_W = 260;
const THUMB_MAX_H = 170;

/**
 * The peek's body for an app with windows (mockup `showPeek`): one thumbnail
 * per window, then a dashed "+" tile for another window. Hovering a
 * thumbnail highlights its window on the desktop and dims the rest
 * (`setPeekedWindow`); clicking it brings the window forward (restoring a
 * minimised one); its × closes the window.
 */
export function PeekThumbs({
  app,
  windows,
  focusedWindowId,
  titleOf,
  onPick,
  onClose,
  onNewWindow,
}: {
  app: ActiveApp;
  windows: FloatingWindow[];
  focusedWindowId: string | null;
  titleOf: (w: FloatingWindow) => string;
  onPick: (w: FloatingWindow) => void;
  onClose: (w: FloatingWindow) => void;
  onNewWindow: () => void;
}) {
  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- the peek's row of thumbnails, stretched so the "+" tile spans their height (mockup `.peek-pop { display: flex }`)
    <div className="flex items-stretch gap-xs">
      {windows.map((w) => (
        <Thumb
          key={w.id}
          app={app}
          window={w}
          title={titleOf(w)}
          focused={w.id === focusedWindowId}
          onPick={() => onPick(w)}
          onClose={() => onClose(w)}
        />
      ))}
      <button
        type="button"
        title={`New ${app.app.name} window`}
        aria-label={`New ${app.app.name} window`}
        onClick={onNewWindow}
        // eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.thumb-add` margin (6px 2px), off the ramp
        className={cn(
          rigidClass(),
          "mx-[2px] my-[6px] w-[34px] rounded-lg border-[1.5px] border-dashed border-input text-faint-foreground",
          "hover:border-primary/60 hover:bg-primary/7 hover:text-primary-text",
        )}
      >
        <Center className="size-full">
          <Icon icon={addIcon} className="size-[15px]" />
        </Center>
      </button>
    </div>
  );
}

/**
 * One window's thumbnail (mockup `.thumb`): a header — the app tile, the
 * window's title, "N tabs" when it holds several, a × that shows on hover —
 * over a still snapshot of the window. The focused window's snapshot wears an
 * accent ring; a minimised one is desaturated under a "Minimised" pill.
 */
function Thumb({
  app,
  window: w,
  title,
  focused,
  onPick,
  onClose,
}: {
  app: ActiveApp;
  window: FloatingWindow;
  title: string;
  focused: boolean;
  onPick: () => void;
  onClose: () => void;
}) {
  const minimized = w.geo.minimized;
  /* eslint-disable layout/no-adhoc-layout -- the snapshot clips to the thumbnail's rounded corner */
  const snapshotClip = cn(
    "overflow-hidden rounded-md",
    minimized && "opacity-60 saturate-[0.4]",
  );
  /* eslint-enable layout/no-adhoc-layout */
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={title}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onPick();
      }}
      onPointerEnter={() => setPeekedWindow(minimized ? null : w.id)}
      onPointerLeave={() => setPeekedWindow(null)}
      // eslint-disable-next-line layout/no-adhoc-layout, spacing/no-adhoc-spacing -- the mockup's `.thumb`: a column whose header is held to the snapshot's width, 6px padding (off the ramp)
      className="group/thumb flex flex-col rounded-xl p-[6px] hover:bg-foreground/5"
    >
      {/* `w-0 min-w-full`: the header takes the snapshot's width instead of
          widening the thumbnail to its title (mockup sets it to the scaled
          width by hand). */}
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.thumb-h` (gap 7px, padding 0 2px 7px), off the ramp */}
      <Line className="h-[26px] w-0 min-w-full gap-[7px] px-[2px] pb-[7px]">
        <DesktopAppTile icon={app.icon} className="size-4 rounded-sm" />
        <Fill>
          <Text variant="caption" className="font-[550]">
            {title}
          </Text>
        </Fill>
        {w.members.length > 1 && (
          <Text tone="faint" className={cn(rigidClass(), "text-2xs")}>
            {w.members.length} tabs
          </Text>
        )}
        <button
          type="button"
          title="Close window"
          aria-label="Close window"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            rigidClass(),
            "size-5 rounded-md text-muted-foreground",
            "pointer-events-none opacity-0 group-hover/thumb:pointer-events-auto group-hover/thumb:opacity-100",
            // The close red, the one the titlebar's close button wears too.
            "hover:bg-destructive hover:text-destructive-foreground",
          )}
        >
          <Center className="size-full">
            <Icon icon={closeIcon} className="size-2.5" />
          </Center>
        </button>
      </Line>
      <div
        className={cn(
          "relative rounded-md bg-card",
          focused
            ? "shadow-[0_0_0_2px_var(--primary),0_2px_6px_rgba(0,0,0,0.08)]"
            : "shadow-[0_0_0_0.5px_var(--input),0_2px_6px_rgba(0,0,0,0.08)]",
        )}
      >
        <div className={snapshotClip}>
          <WindowSnapshot window={w} maxW={THUMB_MAX_W} maxH={THUMB_MAX_H} />
        </div>
        {minimized && (
          <Layer decorative>
            <Center className="size-full">
              {/* The mockup's dark "Minimised" pill: the desktop theme's ink over any snapshot. */}
              {/* eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's pill padding (3px 8px), off the ramp */}
              <span className="rounded-full bg-foreground/70 px-sm py-[3px] text-2xs font-[550] text-background">
                Minimised
              </span>
            </Center>
          </Layer>
        )}
      </div>
    </div>
  );
}
