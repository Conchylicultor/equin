import { FRAME_PROTOCOL } from "./protocol";

/**
 * The frame agent: the content side of the channel (`protocol.ts`). Every
 * HTML document a content route serves gets it injected as the first script
 * of its `<head>` (`injectFrameAgent`, run by the endpoints primitive for
 * every `{ content }` route, so no route can forget it). It waits for the
 * parent's `connect` and then answers the closed set of requests on the port
 * it was handed.
 *
 * **Self-contained by construction**: `installFrameAgent` is serialized with
 * `Function.prototype.toString` and run in the content document's realm, so it
 * may reference nothing outside its own body — no imports, no module
 * bindings (the protocol id is passed in). `frame-agent.test.ts` holds it to
 * that.
 *
 * The agent trusts nothing either: a request it cannot read is answered with
 * an error, and it only ever touches its own document's custom properties,
 * scroll offsets and `resize` event.
 */
export function installFrameAgent(
  win: Window & typeof globalThis,
  protocol: string,
): void {
  const doc = win.document;
  const SCREEN_HEIGHT_VAR = "--prototype-screen-height";
  const RESTORE_DEADLINE_MS = 5000;
  const READER_INPUTS = ["wheel", "touchstart", "keydown", "pointerdown"];
  const ACTIVITY_INPUTS = ["pointermove", "pointerdown", "keydown", "wheel"];
  const ACTIVITY_EVERY_MS = 100;

  type Locator =
    | { kind: "root" }
    | { kind: "id"; id: string }
    | { kind: "path"; path: number[] };
  type Place = { locator: Locator; top: number; left: number };

  let port: MessagePort | null = null;
  let stopRestore: (() => void) | null = null;
  let stopWatch: (() => void) | null = null;

  function post(message: unknown): void {
    port?.postMessage(message);
  }

  function heights(): {
    scrollHeight: number;
    contentHeight: number;
    innerHeight: number;
  } {
    const root = doc.documentElement;
    let content = 0;
    const body = doc.body as HTMLElement | null;
    if (body) {
      for (const child of Array.from(body.children)) {
        const r = child.getBoundingClientRect();
        if (r.bottom > content) content = r.bottom;
      }
      content += win.scrollY;
      const margin = parseFloat(win.getComputedStyle(body).marginBottom);
      if (margin > 0) content += margin;
    }
    return {
      scrollHeight: root.scrollHeight,
      contentHeight: Math.ceil(content),
      innerHeight: win.innerHeight,
    };
  }

  function setScreenHeight(px: number): void {
    const value = String(px) + "px";
    const style = doc.documentElement.style;
    if (style.getPropertyValue(SCREEN_HEIGHT_VAR) === value) return;
    style.setProperty(SCREEN_HEIGHT_VAR, value);
    win.dispatchEvent(new Event("resize"));
  }

  function setVars(vars: Record<string, unknown>): void {
    const style = doc.documentElement.style;
    for (const name of Object.keys(vars)) {
      const value = vars[name];
      if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error("setVars: bad var " + name);
      }
      const prop = "--" + name;
      if (value === "") style.removeProperty(prop);
      else if (style.getPropertyValue(prop) !== value) {
        style.setProperty(prop, value);
      }
    }
  }

  function locatorOf(el: Element): Locator {
    if (el.id !== "") return { kind: "id", id: el.id };
    const path: number[] = [];
    let node: Element = el;
    while (node.parentElement) {
      path.unshift(
        Array.prototype.indexOf.call(node.parentElement.children, node),
      );
      node = node.parentElement;
    }
    return { kind: "path", path };
  }

  function resolve(locator: Locator): Element | null {
    if (locator.kind === "root") return doc.scrollingElement;
    if (locator.kind === "id") return doc.getElementById(locator.id);
    let node: Element | undefined = doc.documentElement;
    for (const i of locator.path) node = node?.children[i];
    return node ?? null;
  }

  function captureScroll(): Place[] {
    const places: Place[] = [];
    const root = doc.scrollingElement;
    if (root && (root.scrollTop !== 0 || root.scrollLeft !== 0)) {
      places.push({
        locator: { kind: "root" },
        top: root.scrollTop,
        left: root.scrollLeft,
      });
    }
    for (const el of Array.from(doc.querySelectorAll("body *"))) {
      if (el.scrollTop === 0 && el.scrollLeft === 0) continue;
      places.push({
        locator: locatorOf(el),
        top: el.scrollTop,
        left: el.scrollLeft,
      });
    }
    return places;
  }

  function restoreScroll(places: Place[]): () => void {
    let pending = places;
    let stopped = false;
    const scrollOne = (place: Place): boolean => {
      const el = resolve(place.locator);
      if (!el) return false;
      el.scrollTop = place.top;
      el.scrollLeft = place.left;
      return (
        Math.abs(el.scrollTop - place.top) <= 1 &&
        Math.abs(el.scrollLeft - place.left) <= 1
      );
    };
    const apply = (): void => {
      pending = pending.filter((place) => !scrollOne(place));
      if (pending.length === 0) stop();
    };
    const observer = new win.MutationObserver(apply);
    const deadline = win.setTimeout(() => stop(), RESTORE_DEADLINE_MS);
    function stop(): void {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      doc.removeEventListener("load", apply, true);
      for (const type of READER_INPUTS)
        doc.removeEventListener(type, stop, true);
      win.clearTimeout(deadline);
    }
    if (pending.length === 0) return stop;
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    doc.addEventListener("load", apply, true);
    for (const type of READER_INPUTS) {
      doc.addEventListener(type, stop, { capture: true, passive: true });
    }
    apply();
    return stop;
  }

  function watchHeight(): () => void {
    let frame: number | null = null;
    let last = "";
    const report = (): void => {
      if (frame !== null) return;
      frame = win.requestAnimationFrame(() => {
        frame = null;
        const h = heights();
        const key = JSON.stringify(h);
        if (key === last) return;
        last = key;
        post({ event: "height", heights: h });
      });
    };
    const resize = new win.ResizeObserver(report);
    resize.observe(doc.documentElement);
    if (doc.body) resize.observe(doc.body);
    const mutation = new win.MutationObserver(report);
    mutation.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    doc.addEventListener("load", report, true);
    report();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      doc.removeEventListener("load", report, true);
      if (frame !== null) win.cancelAnimationFrame(frame);
    };
  }

  function settle(): Promise<null> {
    return new Promise((done) => {
      let n = 0;
      const tick = (): void => {
        n += 1;
        if (n >= 3) done(null);
        else win.requestAnimationFrame(tick);
      };
      win.requestAnimationFrame(tick);
    });
  }

  async function answer(req: Record<string, unknown>): Promise<unknown> {
    switch (req.op) {
      case "setVars":
        if (typeof req.vars !== "object" || req.vars === null)
          throw new Error("setVars: no vars");
        setVars(req.vars as Record<string, unknown>);
        return null;
      case "setScreenHeight":
        if (typeof req.px !== "number" || !(req.px >= 0))
          throw new Error("setScreenHeight: bad px");
        setScreenHeight(req.px);
        return null;
      case "dispatchResize":
        win.dispatchEvent(new Event("resize"));
        return null;
      case "settle":
        return settle();
      case "measure":
        return heights();
      case "watchHeight":
        stopWatch?.();
        stopWatch = watchHeight();
        return null;
      case "unwatchHeight":
        stopWatch?.();
        stopWatch = null;
        return null;
      case "captureScroll":
        return captureScroll();
      case "restoreScroll":
        if (!Array.isArray(req.scroll))
          throw new Error("restoreScroll: no scroll");
        stopRestore?.();
        stopRestore = restoreScroll(req.scroll as Place[]);
        return null;
      case "cancelRestore":
        stopRestore?.();
        stopRestore = null;
        return null;
      default:
        throw new Error("unknown op " + String(req.op));
    }
  }

  function onRequest(event: MessageEvent): void {
    const req = event.data as Record<string, unknown> | null;
    if (typeof req !== "object" || req === null || typeof req.id !== "number")
      return;
    const id = req.id;
    answer(req).then(
      (value) => post({ id, ok: true, value }),
      (err: unknown) =>
        post({
          id,
          ok: false,
          error: String(err instanceof Error ? err.message : err).slice(
            0,
            2000,
          ),
        }),
    );
  }

  let lastActivity = 0;
  function onActivity(): void {
    const now = Date.now();
    if (now - lastActivity < ACTIVITY_EVERY_MS) return;
    lastActivity = now;
    post({ event: "activity" });
  }

  win.addEventListener("message", (event: MessageEvent) => {
    // Only the frame's own parent connects, and only once per document.
    if (port !== null || event.source !== win.parent || event.source === win)
      return;
    const data = event.data as { protocol?: unknown; type?: unknown } | null;
    if (typeof data !== "object" || data === null) return;
    if (data.protocol !== protocol || data.type !== "connect") return;
    const handed = event.ports[0];
    if (!handed) return;
    port = handed;
    port.onmessage = onRequest;
    for (const type of ACTIVITY_INPUTS) {
      win.addEventListener(type, onActivity, { capture: true, passive: true });
    }
  });
}

/** The inline `<script>` that installs the agent in a content document. */
export function frameAgentScript(): string {
  return `<script>(${installFrameAgent.toString()})(window, ${JSON.stringify(FRAME_PROTOCOL)});</script>`;
}

/**
 * `html` with the frame agent as the first script of its `<head>` (or, with
 * no `<head>`, of the document), so it is listening before any of the
 * content's own scripts run.
 */
export function injectFrameAgent(html: string): string {
  const script = frameAgentScript();
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + script + html.slice(at);
}
