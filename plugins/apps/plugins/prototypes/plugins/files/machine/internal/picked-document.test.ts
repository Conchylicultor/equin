import { describe, expect, test } from "bun:test";
import type { PrototypeOption } from "../../core";
import { readOptionSource } from "../../core/option-source";
import {
  servePickedDocument,
  stampPicks,
  withCustomProperties,
} from "./picked-document";

// The one HTMLRewriter REWRITE in the repo: a served document's picks stamped
// onto its `<html>` — a choice as `data-*`, a color as a `--*` in its style.

const PAGE = `<!doctype html><html lang="en" data-pane="flush" style="font-family: &quot;A; B&quot;, serif; --accent: #7c5cff">
<head>
<meta name="prototype-option" content="pane: flush | floating" />
<meta name="prototype-option" content="accent: color violet=#7c5cff | azure=#3b82f6" />
</head><body><html data-pane="x"></html></body></html>`;

const OPTIONS: PrototypeOption[] = [
  {
    kind: "choice",
    name: "pane",
    values: ["flush", "floating"],
    default: "flush",
    group: null,
  },
  {
    kind: "color",
    name: "accent",
    suggestions: [
      { name: "violet", color: "#7c5cff" },
      { name: "azure", color: "#3b82f6" },
    ],
    default: "#7c5cff",
    group: null,
  },
];

describe("withCustomProperties", () => {
  test("replaces the property, keeps the rest, drops later duplicates", () => {
    expect(
      withCustomProperties(
        "color: red; --accent: #000; margin: 0; --accent: #111",
        [["accent", "#3b82f6"]],
      ),
    ).toBe("color: red; margin: 0; --accent: #3b82f6");
  });

  test("appends to an empty style", () => {
    expect(withCustomProperties("", [["accent", "#3b82f6"]])).toBe(
      "--accent: #3b82f6",
    );
  });

  test("a ; inside parentheses or quotes is not a declaration end", () => {
    expect(
      withCustomProperties(`background: url("a;b"); --x: oklch(0.5 0.1 20)`, [
        ["accent", "#3b82f6"],
      ]),
    ).toBe(`background: url("a;b"); --x: oklch(0.5 0.1 20); --accent: #3b82f6`);
  });
});

describe("stampPicks", () => {
  test("a choice becomes data-*, a color a --* in the style; the rest untouched", async () => {
    const out = await stampPicks(PAGE, OPTIONS, {
      pane: "floating",
      accent: "#10b981",
    });
    const source = await readOptionSource(out);
    expect(source.htmlData).toEqual({ pane: "floating" });
    expect(source.htmlVars).toEqual({ accent: "#10b981" });
    // The author's own declaration survives, its quotes included.
    const style = /<html[^>]*style="([^"]*)"/.exec(out)?.[1];
    expect(style).toBeDefined();
    expect(style).toContain("font-family:");
    expect(style).toContain("serif");
    expect(style).not.toContain("#7c5cff");
    // Only the document element is stamped.
    expect(out).toContain('<html data-pane="x">');
  });

  test("a suggestion's name stamps its color", async () => {
    const out = await stampPicks(PAGE, OPTIONS, { accent: "azure" });
    expect((await readOptionSource(out)).htmlVars).toEqual({
      accent: "#3b82f6",
    });
  });

  test("a page with no style gets one", async () => {
    const html = `<html><head><meta name="prototype-option" content="accent: color" /></head></html>`;
    const out = await stampPicks(
      html,
      [
        {
          kind: "color",
          name: "accent",
          suggestions: [],
          default: "#000000",
          group: null,
        },
      ],
      { accent: "#123456" },
    );
    expect(out).toContain('<html style="--accent: #123456">');
  });
});

describe("servePickedDocument", () => {
  test("stamps a valid query, the color given as %23rrggbb", async () => {
    const res = await servePickedDocument(
      PAGE,
      new URLSearchParams("v=3&accent=%233B82F6"),
      { "content-type": "text/html" },
    );
    expect(res.status).toBe(200);
    expect((await readOptionSource(await res.text())).htmlVars).toEqual({
      accent: "#3b82f6",
    });
  });

  test("400 on a color value the option cannot take", async () => {
    for (const qs of ["accent=teal", "accent=%23abc", "accent=red"]) {
      const res = await servePickedDocument(PAGE, new URLSearchParams(qs), {});
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('color option "accent"');
    }
  });

  test("400 on an undeclared option", async () => {
    const res = await servePickedDocument(
      PAGE,
      new URLSearchParams("surface=%23ffffff"),
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("it declares: pane, accent");
  });
});
