/**
 * The helper every page of the engine runs (a context init script, top frame
 * only), reporting to the host through the {@link ENGINE_BINDING} binding.
 * What the screencast cannot carry, it reports instead:
 *
 * - `cursor` — the CSS cursor under the pointer, on change (the host moves the
 *   pointer with `Input.dispatchMouseEvent`, so `mousemove` fires as usual).
 * - `meta` — the document's title and favicon, at load and on every `<title>`
 *   / `<link rel=icon>` change (a MutationObserver — never polled).
 * - `select` — a native `<select>` popup is drawn outside the page, so never
 *   in a screencast frame: its `mousedown` is cancelled and the options + box
 *   reported; the client draws the menu and answers with the picked value.
 *
 * Plain browser JavaScript serialised into the page: no imports, no closures
 * over host values.
 */
export const ENGINE_BINDING = "__equinEngine";

/** What the page script reports (the binding's one argument). */
export type PageReport =
  | { kind: "cursor"; value: string }
  | { kind: "meta"; title: string; favicon: string | null }
  | {
      kind: "select";
      options: {
        value: string;
        label: string;
        disabled: boolean;
        selected: boolean;
      }[];
      rect: { x: number; y: number; width: number; height: number };
    };

/** The two globals the page script shares with the host (the binding, the open select). */
interface EngineWindow {
  __equinEngine?: (report: PageReport) => Promise<void>;
  __equinEngineSelect?: HTMLSelectElement | null;
}

/** Runs in the page (stringified by Playwright's `addInitScript`). */
export function pageScript(): void {
  if (window !== window.top) return;
  const w = window as unknown as EngineWindow;
  const report = (r: PageReport): void => {
    const send = w.__equinEngine;
    if (send) void send(r);
  };

  // ── cursor ───────────────────────────────────────────────────────────
  let lastCursor = "";
  const cursorAt = (target: EventTarget | null): string => {
    if (!(target instanceof Element)) return "default";
    const css = getComputedStyle(target).cursor;
    if (css !== "auto") return css;
    if (target.closest("a[href]")) return "pointer";
    if (
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement &&
        ![
          "button",
          "submit",
          "reset",
          "checkbox",
          "radio",
          "range",
          "color",
          "file",
        ].includes(target.type)) ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return "text";
    }
    // Text content shows the I-beam in a real browser.
    for (const node of Array.from(target.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
        return "text";
      }
    }
    return "default";
  };
  document.addEventListener(
    "mousemove",
    (e) => {
      const value = cursorAt(e.target);
      if (value === lastCursor) return;
      lastCursor = value;
      report({ kind: "cursor", value });
    },
    { capture: true, passive: true },
  );

  // ── title + favicon ──────────────────────────────────────────────────
  let lastMeta = "";
  const reportMeta = (): void => {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    const meta = {
      kind: "meta" as const,
      title: document.title,
      favicon: link?.href || null,
    };
    const key = JSON.stringify(meta);
    if (key === lastMeta) return;
    lastMeta = key;
    report(meta);
  };
  const observe = (): void => {
    reportMeta();
    new MutationObserver((records) => {
      for (const r of records) {
        const el =
          r.target instanceof Element ? r.target : r.target.parentElement;
        if (el?.closest("title, link") || r.type === "childList") {
          reportMeta();
          return;
        }
      }
    }).observe(document.head ?? document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href", "rel"],
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observe, { once: true });
  } else {
    observe();
  }

  // ── <select> popups ──────────────────────────────────────────────────
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!(e.target instanceof Element)) return;
      const select = e.target.closest("select");
      if (!select || select.multiple || select.size > 1 || select.disabled) {
        return;
      }
      e.preventDefault();
      select.focus();
      w.__equinEngineSelect = select;
      const box = select.getBoundingClientRect();
      report({
        kind: "select",
        options: Array.from(select.options).map((o) => ({
          value: o.value,
          label: o.label || o.text,
          disabled: o.disabled,
          selected: o.selected,
        })),
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      });
    },
    true,
  );
}

/** Apply the value picked in the client's menu to the select it was opened on. */
export function applySelect(value: string | null): void {
  const w = window as unknown as EngineWindow;
  const select = w.__equinEngineSelect;
  w.__equinEngineSelect = null;
  if (!select || value === null || select.value === value) return;
  select.value = value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The page's current selection — an input's or textarea's selected text first. */
export function readSelection(): string {
  const el = document.activeElement;
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    el.selectionStart !== null &&
    el.selectionEnd !== null
  ) {
    return el.value.slice(el.selectionStart, el.selectionEnd);
  }
  return window.getSelection()?.toString() ?? "";
}
