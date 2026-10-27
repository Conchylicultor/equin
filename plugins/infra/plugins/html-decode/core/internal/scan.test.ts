import { describe, expect, test } from "bun:test";
import {
  replaceElementText,
  rewriteStartTag,
  scanHtml,
  type ScannedElement,
} from "./scan";

function elements(html: string, name: string): ScannedElement[] {
  const out: ScannedElement[] = [];
  scanHtml(html, { elements: { [name]: (el) => out.push(el) } });
  return out;
}

function texts(html: string, name: string): string[] {
  const out: string[] = [];
  scanHtml(html, { text: { [name]: (t) => out.push(t) } });
  return out;
}

function edited(result: ReturnType<typeof rewriteStartTag>): string {
  if (result.kind !== "edited") throw new Error("expected an edit");
  return result.html;
}

describe("scanHtml", () => {
  test("reads attributes decoded once, names lower-cased, first occurrence wins", () => {
    const [el] = elements(
      `<META Name="og" CONTENT="a &amp;#x27; &#x27;b&#39;" content="second" hidden data-x=raw&amp;>`,
      "meta",
    );
    expect(el!.name).toBe("meta");
    expect(el!.attributeNames).toEqual(["name", "content", "hidden", "data-x"]);
    expect(el!.attr("content")).toBe("a &#x27; 'b'");
    expect(el!.attr("hidden")).toBe("");
    expect(el!.attr("data-x")).toBe("raw&");
    expect(el!.attr("missing")).toBeUndefined();
  });

  test("single-quoted and unquoted values", () => {
    const [el] = elements(`<html lang='en' data-a=b/ style = "x">`, "html");
    expect(el!.attr("lang")).toBe("en");
    expect(el!.attr("data-a")).toBe("b/");
    expect(el!.attr("style")).toBe("x");
  });

  test("tags inside script, style, comments and the title are not tags", () => {
    const html = `<head><title><meta name="t"></title><!-- <meta name="c"> -->
<script>const s = '<meta name="s">';</script><style>/* <meta name="st"> */</style>
<meta name="real"></head>`;
    expect(elements(html, "meta").map((m) => m.attr("name"))).toEqual(["real"]);
  });

  test("text is accumulated across references and decoded once", () => {
    expect(
      texts(`<title>a &amp; b &amp;amp; &#x27;c&#39;</title>`, "title"),
    ).toEqual(["a & b &amp; 'c'"]);
  });

  test("an empty element reports empty text; every element reports", () => {
    expect(
      texts(`<title></title><svg><title>icon</title></svg>`, "title"),
    ).toEqual(["", "icon"]);
  });

  test("script elements report in document order", () => {
    const html = `<script type="text/babel" src="a.jsx"></script><script type="module">x</script>`;
    expect(
      elements(html, "script").map((s) => [s.attr("type"), s.attr("src")]),
    ).toEqual([
      ["text/babel", "a.jsx"],
      ["module", undefined],
    ]);
  });
});

describe("rewriteStartTag", () => {
  const PAGE = `<!doctype html>\n<html\n  lang="en"  data-pane='flush'\n  STYLE="a: &quot;b;c&quot;; --x: 1" >\n<body><html data-pane="x"></html></body></html>`;

  test("rewrites in place, appends new, leaves every other byte", () => {
    const out = edited(
      rewriteStartTag(PAGE, "html", (el) => {
        expect(el.attr("style")).toBe(`a: "b;c"; --x: 1`);
        el.setAttribute("data-pane", "floating");
        el.setAttribute("data-new", "v");
        el.setAttribute("style", `a: "b;c"; --x: 2`);
      }),
    );
    expect(out).toBe(
      `<!doctype html>\n<html\n  lang="en"  data-pane="floating"\n  STYLE="a: &quot;b;c&quot;; --x: 2" data-new="v" >\n<body><html data-pane="x"></html></body></html>`,
    );
  });

  test("no edit returns the document unchanged", () => {
    expect(edited(rewriteStartTag(PAGE, "html", () => {}))).toBe(PAGE);
  });

  test("appends after the name when the tag has no attributes", () => {
    expect(
      edited(
        rewriteStartTag("<html><p>x</p></html>", "html", (el) =>
          el.setAttribute("data-a", `q"&<`),
        ),
      ),
    ).toBe(`<html data-a="q&quot;&amp;<"><p>x</p></html>`);
  });

  test("absent when the document has no such element", () => {
    expect(rewriteStartTag("<p>x</p>", "html", () => {})).toEqual({
      kind: "absent",
    });
  });
});

describe("replaceElementText", () => {
  test("replaces the first element's content, escaped; the rest untouched", () => {
    const html = `<head>\n<title>Old &amp; title</title>\n</head><svg><title>icon</title></svg>`;
    expect(replaceElementText(html, "title", `New <b> & "q"`)).toEqual({
      kind: "edited",
      html: `<head>\n<title>New &lt;b&gt; &amp; "q"</title>\n</head><svg><title>icon</title></svg>`,
    });
  });

  test("an empty element", () => {
    expect(replaceElementText("<title></title>", "title", "x")).toEqual({
      kind: "edited",
      html: "<title>x</title>",
    });
  });

  test("absent, and loud on an element with no end tag", () => {
    expect(replaceElementText("<p>x</p>", "title", "x")).toEqual({
      kind: "absent",
    });
    expect(() => replaceElementText("<div>x", "div", "y")).toThrow(
      /no <\/div>/,
    );
  });
});
