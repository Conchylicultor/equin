import { describe, expect, test } from "bun:test";
import {
  extractVisibleText,
  fingerprintPageText,
  normalizeVisibleText,
} from "./page-text";

// The fingerprint is the whole cache: if it moves on an unchanged page, every
// tick pays for a model call. These assert the two properties it rests on —
// invisible markup churn does NOT move it, a change in what the page SAYS does.

async function page(html: string, maxChars = 1_000_000): Promise<string> {
  const { text } = await extractVisibleText(
    new Response(html, { headers: { "content-type": "text/html" } }),
    maxChars,
  );
  return text;
}

function readPage(html: string, maxChars: number) {
  return extractVisibleText(
    new Response(html, { headers: { "content-type": "text/html" } }),
    maxChars,
  );
}

/** The same listing page, re-served with everything a CMS churns per request. */
function venuePage(opts: { nonce: string; adSlot: string; body: string }): string {
  return `<!doctype html><html><head>
      <title>Fitzroy — Soirées</title>
      <meta name="csrf-token" content="${opts.nonce}">
      <link rel="stylesheet" href="/assets/app.${opts.nonce}.css">
      <style>.hero { color: #${opts.nonce.slice(0, 6)}; }</style>
      <script nonce="${opts.nonce}">window.__ADS = ${JSON.stringify(opts.adSlot)};</script>
    </head><body>
      <nav><a href="/">Home</a><a href="/contact">Contact</a></nav>
      <main>${opts.body}</main>
      <svg viewBox="0 0 10 10"><text>logo</text></svg>
      <footer>© 2026 Fitzroy — private hire enquiries</footer>
    </body></html>`;
}

const BODY = `<h1>Soirées</h1><ul><li>Techno Thursdays — every Thursday, 23:00, free before midnight</li><li>Jazz Brunch — Sunday 9 August, 12:00</li></ul>`;

describe("extractVisibleText", () => {
  test("keeps the readable text and drops the chrome", async () => {
    const text = await page(venuePage({ nonce: "abc123", adSlot: "slot-1", body: BODY }));
    expect(text).toContain("Techno Thursdays");
    expect(text).toContain("Jazz Brunch");
    // Navigation, footer boilerplate, inline SVG labels, CSS and JS are not
    // things a reader reads — they are churn the model would pay tokens for.
    expect(text).not.toContain("Contact");
    expect(text).not.toContain("private hire");
    expect(text).not.toContain("logo");
    expect(text).not.toContain("__ADS");
    expect(text).not.toContain(".hero");
  });

  test("separates block elements so a list is not one word", async () => {
    const text = await page(`<ul><li>Foo</li><li>Bar</li></ul>`);
    expect(text).toBe("Foo\nBar");
  });

  test("decodes character references exactly once", async () => {
    // The rewriter hands back raw markup source; this is the `d&#x27;` bug.
    const text = await page(`<p>Nuit d&#x27;été &amp; co</p>`);
    expect(text).toBe("Nuit d'été & co");
    // Once, not to a fixed point: the page really did encode a literal `&#x27;`.
    expect(await page(`<p>&amp;#x27;</p>`)).toBe("&#x27;");
  });

  test("survives a self-closing svg", async () => {
    // The single-pass `onEndTag` strip throws `HTMLRewriterError: No end tag.`
    // here, which is why the strip is a separate rewriter pass.
    const text = await page(`<p>Before</p><svg/><p>After</p>`);
    expect(text).toBe("Before\nAfter");
  });
});

describe("extractVisibleText — the text bound", () => {
  // The bound is on TEXT, not markup, because text is what the model is billed
  // to read — and because markup length says nothing about where the content is.

  test("markup far past the bound costs nothing when its text is small", async () => {
    // The shape that broke fitzroy-paris.com under a byte cap: ~700 KB of inline
    // <style> ahead of one line of readable content. Bounding text sees it whole.
    const html =
      `<html><head><style>${"a{color:#fff}".repeat(60_000)}</style></head>` +
      `<body><p>Techno Night — 25 August</p></body></html>`;
    const { text, truncated } = await readPage(html, 200_000);

    expect(truncated).toBe(false);
    expect(text).toContain("Techno Night — 25 August");
  });

  test("reports truncation when readable content is dropped", async () => {
    const html = `<p>${"Techno Night. ".repeat(200)}</p><p>Jazz Brunch</p>`;
    const { text, truncated } = await readPage(html, 100);

    expect(truncated).toBe(true);
    expect(text).not.toContain("Jazz Brunch");
  });

  test("does not report truncation for trailing markup that carries no reading", async () => {
    // A false positive here parks a healthy source, so separators and the empty
    // chunk Bun emits at a text node's end must not count as dropped content.
    const { truncated } = await readPage(`<p>${"x".repeat(100)}</p><div></div>\n  `, 100);
    expect(truncated).toBe(false);
  });
});

describe("normalizeVisibleText", () => {
  test("collapses whitespace and drops blank lines", () => {
    expect(normalizeVisibleText("  Techno   Night \n\n\n   \n Jazz  \n")).toBe(
      "Techno Night\nJazz",
    );
  });

  test("folds non-breaking spaces and drops zero-width marks", () => {
    // A `&nbsp;` before the currency is a typographic choice, not a content
    // change; a zero-width space must not split a word.
    expect(normalizeVisibleText("12\u00A0\u20AC / ni\u200Bght")).toBe(
      "12 \u20AC / night",
    );
  });

  test("normalizes to NFC so decomposed accents are the same text", () => {
    expect(normalizeVisibleText("soire\u0301e")).toBe(
      normalizeVisibleText("soir\u00E9e"),
    );
  });
});

describe("fingerprintPageText", () => {
  test("is stable across nonce / ad-slot / asset-hash churn", async () => {
    const first = await page(venuePage({ nonce: "abc123", adSlot: "slot-1", body: BODY }));
    const second = await page(venuePage({ nonce: "zzz999", adSlot: "slot-7", body: BODY }));
    expect(fingerprintPageText(second)).toBe(fingerprintPageText(first));
  });

  test("is stable across reflow of the same words", async () => {
    const a = await page(`<div><p>Techno Night</p></div>`);
    const b = await page(`<div>\n   <p>\n     Techno   Night\n   </p>\n</div>`);
    expect(fingerprintPageText(b)).toBe(fingerprintPageText(a));
  });

  test("moves when the page announces a new party", async () => {
    const before = await page(venuePage({ nonce: "abc123", adSlot: "slot-1", body: BODY }));
    const after = await page(
      venuePage({
        nonce: "abc123",
        adSlot: "slot-1",
        body: `${BODY}<p>Disco Friday — 14 August, 22:00</p>`,
      }),
    );
    expect(fingerprintPageText(after)).not.toBe(fingerprintPageText(before));
  });

  test("is a sha256 hex digest", () => {
    expect(fingerprintPageText("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
