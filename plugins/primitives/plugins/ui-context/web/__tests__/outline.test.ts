import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectMeta } from "../internal/collect-meta";
import { collectOutline, formatOutline } from "../internal/outline";
import { resolveUiContext } from "../internal/resolve";

// jsdom lays nothing out: every box is 0×0. Give each element a box, except
// under `data-zero` (standing in for a collapsed / display:none subtree).
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const size = this.closest("[data-zero]") ? 0 : 10;
      return new DOMRect(0, 0, size, size);
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const APP =
  'data-lineage="contribution" data-plugin-id="apps.pages.shell" data-slot-id="apps.app" data-contribution-id="" data-lineage-boxless=""';
const PANE =
  'data-lineage="region" data-region-kind="pane" data-region-id="page" data-region-label="column 1 of 1" data-plugin-id="pages/page" data-lineage-boxless=""';
const SHARE =
  'data-lineage="contribution" data-plugin-id="pages/share" data-slot-id="PaneToolbar.Item" data-contribution-id=""';
const MORE =
  'data-lineage="contribution" data-plugin-id="pages/more" data-slot-id="PaneToolbar.Item" data-contribution-id=""';

const PANE_PATH =
  "apps.pages.shell@apps.app > pages/page#pane:page[column 1 of 1]";

function mount() {
  document.body.innerHTML = `
    <button>Home</button>
    <span ${APP}><span ${PANE}>
      <div ${SHARE}><button aria-label="Share"></button></div>
      <div ${MORE}>
        <button>Open</button><button>Open</button>
        <div role="tab">Details</div>
      </div>
      <a href="/x">Read more</a>
      <a>no href</a>
      <button></button>
      <button hidden>Hidden attr</button>
      <div aria-hidden="true"><button>Aria hidden</button></div>
      <div data-zero><button>Collapsed</button></div>
      <div id="excluded"><button>Mine</button></div>
    </span></span>`;
}

describe("collectOutline", () => {
  it("keeps every shown named control, grouped by lineage, deduped with a count", () => {
    mount();
    const outline = collectOutline(document.body, {
      exclude: [document.getElementById("excluded")!],
    });
    expect(outline.truncated).toBe(false);
    expect(outline.entries).toEqual([
      { path: "", element: "button — Home", count: 1 },
      {
        path: `${PANE_PATH} > pages/share@PaneToolbar.Item`,
        element: "button — Share",
        count: 1,
      },
      {
        path: `${PANE_PATH} > pages/more@PaneToolbar.Item`,
        element: "button — Open",
        count: 2,
      },
      {
        path: `${PANE_PATH} > pages/more@PaneToolbar.Item`,
        element: "div[role=tab] — Details",
        count: 1,
      },
      { path: PANE_PATH, element: "a — Read more", count: 1 },
    ]);
  });

  it("caps the distinct entries and says so", () => {
    mount();
    const outline = collectOutline(document.body, { limit: 2 });
    expect(outline.entries.map((e) => e.element)).toEqual([
      "button — Home",
      "button — Share",
    ]);
    expect(outline.truncated).toBe(true);
  });

  it("formats an indented tree, shared prefixes once, single chains folded", () => {
    mount();
    const text = formatOutline(
      collectOutline(document.body, {
        exclude: [document.getElementById("excluded")!],
      }),
    );
    expect(text).toBe(
      [
        "button — Home",
        PANE_PATH,
        "  a — Read more",
        "  pages/share@PaneToolbar.Item",
        "    button — Share",
        "  pages/more@PaneToolbar.Item",
        "    button — Open ×2",
        "    div[role=tab] — Details",
      ].join("\n"),
    );
  });

  it("marks a truncated outline", () => {
    mount();
    expect(formatOutline(collectOutline(document.body, { limit: 1 }))).toBe(
      "button — Home\n… more controls not listed (capped at 1)",
    );
  });
});

describe("resolveUiContext", () => {
  it("round-trips collectMeta for every outlined control", () => {
    mount();
    for (const el of [
      document.querySelector('[aria-label="Share"]')!,
      document.querySelector('[role="tab"]')!,
      document.querySelector("a[href]")!,
      document.querySelector("button")!,
    ]) {
      const meta = collectMeta(el);
      expect(
        resolveUiContext({ path: meta.path ?? "", element: meta.element }),
      ).toEqual({ kind: "found", el });
    }
  });

  it("finds a control named by a partial path (its segments in order)", () => {
    mount();
    const share = document.querySelector('[aria-label="Share"]');
    // Only the pane line, as an agent copying one outline line writes it.
    expect(
      resolveUiContext({
        path: "pages/page#pane:page[column 1 of 1]",
        element: "button — Share",
      }),
    ).toEqual({ kind: "found", el: share });
    // Segments out of order are not its lineage.
    expect(
      resolveUiContext({
        path: "pages/share@PaneToolbar.Item > apps.pages.shell@apps.app",
        element: "button — Share",
      }),
    ).toMatchObject({ kind: "gone" });
  });

  it("matches a pane whatever its column label says now", () => {
    mount();
    const share = document.querySelector('[aria-label="Share"]');
    // Written while the pane was column 2 of 2; another column has since
    // opened or closed. The label is position, not identity.
    for (const path of [
      "apps.pages.shell@apps.app > pages/page#pane:page[column 2 of 3] > pages/share@PaneToolbar.Item",
      "pages/page#pane:page[column 2 of 2]",
      "pages/page#pane:page",
    ])
      expect(resolveUiContext({ path, element: "button — Share" })).toEqual({
        kind: "found",
        el: share,
      });
    // A different pane id is a different pane.
    expect(
      resolveUiContext({
        path: "pages/page#pane:other[column 1 of 1]",
        element: "button — Share",
      }).kind,
    ).toBe("gone");
  });

  it("prefers an exact path over a partial reading of it", () => {
    document.body.innerHTML = `
      <span ${APP}><span ${PANE}>
        <button id="direct">Go</button>
        <div ${SHARE}><button>Go</button></div>
      </span></span>`;
    // Both buttons hold the pane's segments; only one's lineage IS the path.
    expect(
      resolveUiContext({ path: PANE_PATH, element: "button — Go" }),
    ).toEqual({ kind: "found", el: document.getElementById("direct") });
  });

  it("is ambiguous when several shown controls match, first in document order", () => {
    mount();
    const opens = [...document.querySelectorAll("button")].filter(
      (b) => b.textContent === "Open",
    );
    const r = resolveUiContext({
      path: `${PANE_PATH} > pages/more@PaneToolbar.Item`,
      element: "button — Open",
    });
    expect(r).toEqual({ kind: "ambiguous", el: opens[0], count: 2 });
  });

  it("is gone for a hidden, collapsed, mis-pathed or malformed name", () => {
    mount();
    for (const ref of [
      { path: PANE_PATH, element: "button — Aria hidden" },
      { path: PANE_PATH, element: "button — Collapsed" },
      { path: PANE_PATH, element: "button — Hidden attr" },
      { path: "", element: "button — Share" },
      { path: PANE_PATH, element: "Share" },
    ])
      expect(resolveUiContext(ref)).toMatchObject({ kind: "gone" });
  });

  it("says what the page holds instead when gone", () => {
    mount();
    expect(
      resolveUiContext({ path: PANE_PATH, element: "button — Aria hidden" }),
    ).toEqual({
      kind: "gone",
      near: {
        notADescriptor: false,
        // There, but withdrawn.
        sameElement: [{ path: PANE_PATH, shown: false }],
        // What is shown where the path points (a renamed control shows here).
        underPath: [
          "button — Share",
          "button — Open",
          "div[role=tab] — Details",
          "a — Read more",
          "button",
          "button — Mine",
        ],
      },
    });
    // Elsewhere on the page: the same control, under another path.
    expect(
      resolveUiContext({
        path: "pages/other#pane:x",
        element: "button — Share",
      }),
    ).toMatchObject({
      kind: "gone",
      near: {
        sameElement: [
          { path: `${PANE_PATH} > pages/share@PaneToolbar.Item`, shown: true },
        ],
      },
    });
    expect(resolveUiContext({ path: PANE_PATH, element: "Share" })).toEqual({
      kind: "gone",
      near: { notADescriptor: true, sameElement: [], underPath: [] },
    });
  });

  it("compares canonical spellings", () => {
    mount();
    const r = resolveUiContext({
      path: `  ${PANE_PATH}  >  pages/share@PaneToolbar.Item `,
      element: "button —   Share",
    });
    expect(r.kind).toBe("found");
  });
});
