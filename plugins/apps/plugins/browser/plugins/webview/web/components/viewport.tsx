import { useEffect, useRef } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Browser,
  useBrowserNav,
  useBrowserProxy,
  useBrowserTabs,
} from "@plugins/apps/plugins/browser/plugins/shell/web";
import {
  proxyUrl,
  isProxyUrl,
  parseBrowserProxyNavMessage,
} from "@plugins/apps/plugins/browser/plugins/proxy/core";
import { isProxyEscape } from "../escape-detect";
import { EscapeOverlay } from "./escape-overlay";
import { LoadingBar } from "./loading-bar";

/**
 * Base iframe sandbox capabilities. `allow-same-origin` is appended ONLY for
 * direct (non-proxied) cross-origin loads — see {@link Viewport}.
 */
const BASE_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/**
 * The webview viewport. Every tab with a real URL keeps a persistent iframe so
 * switching tabs preserves the loaded page; only the active tab is visible. The
 * active tab's start page (URL `""`) renders the contributed start page.
 */
export function Viewport() {
  const { tabs, finishLoad, open } = useBrowserTabs();
  const { enabled } = useBrowserProxy();
  const { current, navigate, commit, syncDisplay, reload, markEscaped, clearEscaped } =
    useBrowserNav();
  const activeLoading = tabs.find((t) => t.active)?.loading ?? false;
  const activeId = tabs.find((t) => t.active)?.id;

  // Map tabId → iframe element, populated via each iframe's ref callback. Used
  // to match an incoming postMessage `e.source` against our own iframes (and
  // specifically the active one) before trusting it as a nav request.
  const framesRef = useRef(new Map<string, HTMLIFrameElement>());

  // Whether the active frame posted a `commit` since its last `onLoad`. A
  // proxied HTML document always commits (the injected shim posts it as it
  // runs, before `onLoad`); an un-proxied escape destination never does. This
  // is the signal that distinguishes a real proxied load from an escape.
  const committedRef = useRef(false);

  // NAV SYNC: the proxied page can't self-navigate (it runs in an opaque
  // origin and the injected script intercepts link clicks). It instead posts a
  // nav message to us; we route it through `navigate()` so the omnibox +
  // history stay in sync and the page reloads through the proxy exactly once.
  // We only honor messages whose `e.source` is the ACTIVE tab's iframe — only
  // the visible iframe receives user clicks, and an inactive/foreign frame must
  // not be able to hijack navigation.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = parseBrowserProxyNavMessage(e.data);
      if (!msg) return;
      if (!activeId) return;
      const activeFrame = framesRef.current.get(activeId);
      if (!activeFrame || e.source !== activeFrame.contentWindow) return;
      switch (msg.kind) {
        case "navigate":
          navigate(msg.url);
          break;
        case "commit":
          committedRef.current = true;
          commit(msg.url);
          break;
        case "sync":
          syncDisplay(msg.url);
          break;
        case "newtab":
          open(msg.url);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [activeId, navigate, commit, syncDisplay, open]);

  return (
    <Overlay
      fill
      className="h-full w-full bg-background"
      above={activeLoading ? <LoadingBar /> : undefined}
    >
      {tabs.map((tab) => {
        // When proxy mode is on, real URLs load through the same-origin proxy
        // (the start page, URL `""`, has no iframe).
        const src = enabled && tab.url !== "" ? proxyUrl(tab.url) : tab.url;
        // SECURITY: proxied content is served from OUR origin. If the iframe
        // kept `allow-same-origin` while same-origin (proxied), the foreign
        // page's JS would be same-origin with the equin app and could
        // reach `window.parent`. So we DROP `allow-same-origin` for proxied
        // (same-origin) src — opaque, isolated origin — and only add it back
        // for direct cross-origin loads (where a site is same-origin with
        // itself, not with us). See the security model in the design doc.
        const sandbox = isProxyUrl(src)
          ? BASE_SANDBOX
          : `${BASE_SANDBOX} allow-same-origin`;

        return (
          <div
            key={tab.id}
            className={cn("h-full w-full", !tab.active && "hidden")}
          >
            {tab.url === "" ? (
              tab.active ? (
                <StartPageHost />
              ) : null
            ) : (
              <Overlay
                fill
                className="h-full w-full"
                above={
                  tab.escaped ? (
                    <EscapeOverlay
                      url={current}
                      onReload={reload}
                      onDismiss={clearEscaped}
                    />
                  ) : undefined
                }
              >
                <iframe
                  key={`${tab.id}:${tab.loadKey}`}
                  ref={(el) => {
                    if (el) {
                      framesRef.current.set(tab.id, el);
                    } else {
                      framesRef.current.delete(tab.id);
                    }
                  }}
                  src={src}
                  title="Browser viewport"
                  className="h-full w-full border-0"
                  sandbox={sandbox}
                  referrerPolicy="no-referrer"
                  onLoad={() => {
                    // A proxied HTML document commits before `onLoad` fires; an
                    // un-proxied escape destination never commits. An
                    // iframe-initiated load (not `loading` — the parent didn't
                    // start it) of a proxied tab that produced no commit is an
                    // escape the in-page shim couldn't intercept (a JS
                    // `location` assignment / scripted `form.submit()`). Judged
                    // only for the active tab, whose commits are the ones we track.
                    const committed = committedRef.current;
                    committedRef.current = false;
                    const wasLoading = tab.loading;
                    finishLoad(tab.id);
                    if (
                      isProxyEscape({
                        active: tab.active,
                        proxyEnabled: enabled,
                        proxiedSrc: isProxyUrl(src),
                        wasLoading,
                        committed,
                      })
                    ) {
                      markEscaped();
                    }
                  }}
                />
              </Overlay>
            )}
          </div>
        );
      })}
    </Overlay>
  );
}

/**
 * Renders the contributed start page, or a tiny inline hint if none is
 * registered yet (the start-page plugin lands in a later wave).
 */
function StartPageHost() {
  const startPages = Browser.StartPage.useContributions();
  if (startPages.length > 0) {
    return (
      // eslint-disable-next-line layout/no-adhoc-layout -- start page scrolls within the fixed-height viewport box.
      <div className="h-full w-full overflow-auto">
        <Browser.StartPage.Render />
      </div>
    );
  }
  return (
    <Center className="h-full w-full">
      <Placeholder>Enter a URL to begin</Placeholder>
    </Center>
  );
}
