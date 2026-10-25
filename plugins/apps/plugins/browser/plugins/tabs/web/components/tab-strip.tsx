import { useState, type KeyboardEvent } from "react";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { hoverRevealGroup } from "@plugins/primitives/plugins/hover-reveal/web";
import { TabCloseButton } from "@plugins/ui/plugins/tab-bar/web";
import {
  useBrowserTabs,
  Favicon,
} from "@plugins/apps/plugins/browser/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import "./tab-strip.css";

const addIcon = symbol("add");

const FAVICON_SIZE = 16;

/**
 * A readable label for a tab: the page's title, else the URL's host (sans
 * `www.`), or "New tab" for the start page.
 */
function tabLabel(url: string, title: string): string {
  if (!url) return "New tab";
  if (title) return title;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch (err) {
    if (err instanceof TypeError) return url; // invalid URL — show raw
    throw err;
  }
}

/** The page's own icon (reported by the engine), else the host's. */
function TabFavicon({
  url,
  faviconUrl,
}: {
  url: string;
  faviconUrl: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!faviconUrl || failed === faviconUrl) {
    return <Favicon url={url} size={FAVICON_SIZE} />;
  }
  return (
    <img
      src={faviconUrl}
      alt=""
      width={FAVICON_SIZE}
      height={FAVICON_SIZE}
      style={{ width: FAVICON_SIZE, height: FAVICON_SIZE }}
      onError={() => setFailed(faviconUrl)}
    />
  );
}

/**
 * The in-app tab strip, shaped like Chrome's (geometry in `tab-strip.css`):
 * every tab is the same box, so hovering one paints a rounded pill INSIDE it
 * and nothing moves; the active tab paints its whole box in the content colour
 * and flares into the toolbar below. Clicking selects, middle-click or the ×
 * closes, and the trailing + opens a fresh start-page tab.
 */
export function TabStrip() {
  const { tabs, select, open, close } = useBrowserTabs();

  return (
    <ControlSizeProvider size="sm">
      <Line className="browser-tabs w-full">
        <Line className="browser-tab-list">
          {tabs.map((tab) => {
            const label = tabLabel(tab.url, tab.title);
            return (
              <Line
                key={tab.id}
                as="div"
                role="button"
                tabIndex={0}
                aria-pressed={tab.active}
                title={label}
                className={cn(
                  "browser-tab",
                  hoverRevealGroup,
                  tab.active && "is-active",
                )}
                onClick={() => select(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) close(tab.id);
                }}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select(tab.id);
                  }
                }}
              >
                <span className={cn("browser-tab-icon", rigidClass())}>
                  {tab.loading ? (
                    <Spinner />
                  ) : (
                    <TabFavicon url={tab.url} faviconUrl={tab.faviconUrl} />
                  )}
                </span>
                <Fill>
                  <Text variant="control" className="browser-tab-label">
                    {label}
                  </Text>
                </Fill>
                <TabCloseButton
                  label={label}
                  active={tab.active}
                  onClose={() => close(tab.id)}
                />
              </Line>
            );
          })}
        </Line>
        <span className={cn("browser-tab-new", rigidClass())}>
          <IconButton
            icon={addIcon}
            label="New tab"
            tooltip="New tab"
            onClick={() => open()}
          />
        </span>
      </Line>
    </ControlSizeProvider>
  );
}
