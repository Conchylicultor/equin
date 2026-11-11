import { describe, expect, test } from "bun:test";
import { semanticHtml } from "./semantic-html";

describe("semanticHtml", () => {
  test("keeps the semantic elements and drops every attribute", () => {
    expect(
      semanticHtml(
        '<h1 class="x" id="t">Title</h1><p style="color:red">Some <strong class="b">bold</strong> and <em>em</em>.</p>',
      ),
    ).toBe(
      "<h1>Title</h1>\n<p>Some <strong>bold</strong> and <em>em</em>.</p>",
    );
  });

  test("unwraps wrappers, separating boxes (spans included) by a space", () => {
    expect(
      semanticHtml(
        "<div><div>one</div><div>two</div></div><p><span>name</span><span>description</span></p>",
      ),
    ).toBe("<p>one two</p>\n<p>name description</p>");
  });

  test("text-level markup is unwrapped without a boundary", () => {
    expect(semanticHtml("<p>H<sub>2</sub>O is <b>wet</b>ter</p>")).toBe(
      "<p>H2O is wetter</p>",
    );
  });

  test("a span a word is written straight against is part of that word", () => {
    // The wordmark: `equin` with its styled full stop.
    expect(
      semanticHtml(
        '<a href="/"><span class="b">equin<span class="t">.</span></span></a><p>x</p>',
      ),
    ).toBe('<p><a href="/">equin.</a></p>\n<p>x</p>');
    expect(semanticHtml("<p>Price <span>$</span>5 today</p>")).toBe(
      "<p>Price $5 today</p>",
    );
    // A space written beside it, or a box beside it, still separates.
    expect(semanticHtml("<p>equin <span>.</span> x</p>")).toBe(
      "<p>equin . x</p>",
    );
    expect(
      semanticHtml("<p><span>name</span><span>description</span></p>"),
    ).toBe("<p>name description</p>");
  });

  test("text left at the top level is wrapped in a paragraph", () => {
    expect(
      semanticHtml(
        "<h1>Story</h1><div>More details soon</div><p>This page is still being written.</p><span>footer</span>",
      ),
    ).toBe(
      "<h1>Story</h1>\n<p>More details soon</p>\n<p>This page is still being written.</p>\n<p>footer</p>",
    );
    // A run holding a block (a link around a card) cannot be a paragraph.
    expect(semanticHtml('<div data-link="/c"><h3>Card</h3></div>')).toBe(
      '<a href="/c"><h3>Card</h3></a>',
    );
  });

  test("an a[href] stays a link with only its href", () => {
    expect(
      semanticHtml(
        '<p>Go <a href="/about/download" class="c" target="_blank">download</a> now</p>',
      ),
    ).toBe('<p>Go <a href="/about/download">download</a> now</p>');
  });

  test("an a without href is unwrapped", () => {
    expect(semanticHtml("<p><a>text</a></p>")).toBe("<p>text</p>");
  });

  test("data-link on a control becomes <a href> around its text", () => {
    expect(
      semanticHtml(
        '<nav><button type="button" data-link="/about/guide"><svg><path/></svg><span>Read the guide</span></button></nav>',
      ),
    ).toBe('<p><a href="/about/guide">Read the guide</a></p>');
  });

  test("data-link on a kept block keeps the tag with the link inside", () => {
    expect(semanticHtml('<h2 data-link="/about/vision">The vision</h2>')).toBe(
      '<h2><a href="/about/vision">The vision</a></h2>',
    );
  });

  test("data-link on a card wraps its whole content, headings included", () => {
    expect(
      semanticHtml(
        '<div data-link="/about/foundations"><h3>Foundations</h3><p>What lies under.</p></div>',
      ),
    ).toBe(
      '<a href="/about/foundations"><h3>Foundations</h3>\n<p>What lies under.</p></a>',
    );
  });

  test("links never nest: an inner link is unwrapped", () => {
    expect(
      semanticHtml(
        '<div data-link="/outer">outer <span data-link="/inner">inner</span> <button data-link="/x">x</button></div>',
      ),
    ).toBe('<p><a href="/outer">outer inner x</a></p>');
  });

  test("drops drawings, scripts, styles and controls with their subtree", () => {
    expect(
      semanticHtml(
        "<p>a<svg><text>svg text</text></svg>b<canvas>c</canvas><script>x()</script><style>.a{}</style></p><button>Copy</button><input value=v><select><option>o</option></select><textarea>t</textarea>",
      ),
    ).toBe("<p>ab</p>");
  });

  test("drops aria-hidden subtrees but keeps hidden (closed fold) content", () => {
    expect(
      semanticHtml(
        '<span aria-hidden="true">decor</span><div hidden="until-found"><p>Step 2: run it</p></div>',
      ),
    ).toBe("<p>Step 2: run it</p>");
  });

  test("img keeps src and alt; without a non-empty alt it is decoration", () => {
    expect(
      semanticHtml(
        '<figure><img src="/a.png" alt="A desktop" class="x" width="3"><img src="/b.png"><img src="/c.png" alt=""><figcaption>Caption</figcaption></figure>',
      ),
    ).toBe(
      '<figure><img src="/a.png" alt="A desktop"><figcaption>Caption</figcaption></figure>',
    );
  });

  test("a link holding only an image keeps it", () => {
    expect(semanticHtml('<a href="/"><img src="/l.png" alt="equin"></a>')).toBe(
      '<p><a href="/"><img src="/l.png" alt="equin"></a></p>',
    );
  });

  test("an icon-only link keeps its aria-label as its text", () => {
    expect(
      semanticHtml(
        '<footer><a href="https://github.com/x" aria-label="equin on GitHub"><svg><path/></svg></a></footer>',
      ),
    ).toBe('<p><a href="https://github.com/x">equin on GitHub</a></p>');
  });

  test("a data-link control with no text keeps its aria-label", () => {
    expect(
      semanticHtml(
        '<button data-link="/about" aria-label="Home"><svg/></button>',
      ),
    ).toBe('<p><a href="/about">Home</a></p>');
  });

  test("an icon-only link without a label is named by its drawing's <title>", () => {
    expect(
      semanticHtml(
        '<a href="/gh"><svg><title> GitHub\n repo </title><path/></svg></a>',
      ),
    ).toBe('<p><a href="/gh">GitHub repo</a></p>');
  });

  test("aria-label wins over the drawing's title; own text wins over both", () => {
    expect(
      semanticHtml(
        '<a href="/a" aria-label="Label"><svg><title>Title</title></svg></a><a href="/b" aria-label="Label">Text</a>',
      ),
    ).toBe('<p><a href="/a">Label</a><a href="/b">Text</a></p>');
  });

  test("an aria-hidden drawing's title names nothing", () => {
    expect(
      semanticHtml(
        '<a href="/x"><svg aria-hidden="true"><title>Hidden</title></svg></a><p>after</p>',
      ),
    ).toBe("<p>after</p>");
  });

  test("an icon-only link holding an img[alt] keeps the image", () => {
    expect(
      semanticHtml(
        '<a href="/" aria-label="Home"><img src="/l.png" alt="equin"></a>',
      ),
    ).toBe('<p><a href="/"><img src="/l.png" alt="equin"></a></p>');
  });

  test("a link whose only image is decorative (empty alt) and has no name goes", () => {
    expect(semanticHtml('<a href="/"><img src="/l.png" alt=""></a>')).toBe("");
  });

  test("empty kept elements are dropped", () => {
    expect(
      semanticHtml(
        '<p> </p><ul><li><span></span></li></ul><a href="/x"><svg/></a><h2></h2><p>kept</p>',
      ),
    ).toBe("<p>kept</p>");
  });

  test("lists, quotes and tables", () => {
    expect(
      semanticHtml(
        "<ol><li>one</li><li>two</li></ol><blockquote>q</blockquote><table><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>",
      ),
    ).toBe(
      "<ol><li>one</li>\n<li>two</li></ol>\n<blockquote>q</blockquote>\n<table><thead><tr><th>h</th></tr></thead>\n<tbody><tr><td>d</td></tr></tbody></table>",
    );
  });

  test("collapses whitespace, moving an inline element's edge spaces outside it", () => {
    expect(semanticHtml("<p>\n  a   <strong> b </strong>c\t\n d  </p>")).toBe(
      "<p>a <strong>b</strong> c d</p>",
    );
  });

  test("pre keeps its whitespace verbatim, code inside included", () => {
    expect(
      semanticHtml(
        '<pre class="x"><code><span>curl -fsSL x |</span>\n  <span>sh</span></code></pre>',
      ),
    ).toBe("<pre><code>curl -fsSL x |\n  sh</code></pre>");
  });

  test("br is kept between content and trimmed at a block's edges", () => {
    expect(semanticHtml("<p><br>a<br>b<br></p>")).toBe("<p>a<br>b</p>");
  });

  test("values pass through verbatim: entities are neither decoded nor doubled", () => {
    expect(
      semanticHtml(
        '<p title="x">Tom &amp; Jerry &lt;3 &#x27;q&#x27;</p><a href="/s?a=1&amp;b=2">s</a>',
      ),
    ).toBe(
      '<p>Tom &amp; Jerry &lt;3 &#x27;q&#x27;</p>\n<p><a href="/s?a=1&amp;b=2">s</a></p>',
    );
  });

  test("the document head and comments are dropped", () => {
    expect(
      semanticHtml(
        "<html><head><title>T</title><meta name=x></head><body><!--$--><p>b</p><!--/$--></body></html>",
      ),
    ).toBe("<p>b</p>");
  });

  describe("an image whose src is no address is its alt", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";

    test("standing alone: a figure captioned by the alt", () => {
      expect(
        semanticHtml(
          `<div><img src="${data}" alt="A  desktop"></div><p>Next</p>`,
        ),
      ).toBe(
        "<figure><figcaption>A desktop</figcaption></figure>\n<p>Next</p>",
      );
      expect(semanticHtml('<ul><li><img alt="No source"></li></ul>')).toBe(
        "<ul><li><figure><figcaption>No source</figcaption></figure></li></ul>",
      );
    });

    test("without an alt it is decoration and goes", () => {
      expect(
        semanticHtml(`<div><img src="${data}" alt=" "><p>T</p></div>`),
      ).toBe("<p>T</p>");
    });

    test("inside a link its alt is the link's text", () => {
      expect(
        semanticHtml(`<a href="/"><img src="${data}" alt="equin"></a>`),
      ).toBe('<p><a href="/">equin</a></p>');
      expect(
        semanticHtml(
          `<span data-link="/apps"><img src="${data}" alt="Sonata"><span>Music</span></span>`,
        ),
      ).toBe('<p><a href="/apps">Sonata Music</a></p>');
    });

    test("where a figure cannot stand, its alt is text", () => {
      expect(
        semanticHtml(`<p>See <img src="${data}" alt="the logo"> here</p>`),
      ).toBe("<p>See the logo here</p>");
      expect(
        semanticHtml(
          `<figure><img src="${data}" alt="Shot"><figcaption>Caption</figcaption></figure>`,
        ),
      ).toBe("<figure>Shot<figcaption>Caption</figcaption></figure>");
    });

    test("an addressed src keeps the img", () => {
      expect(
        semanticHtml(
          '<div><img src="https://x.dev/a.png" alt="A"><img src="/b.png" alt="B"><img src="//cdn/c.png" alt="C"></div>',
        ),
      ).toBe(
        '<p><img src="https://x.dev/a.png" alt="A"><img src="/b.png" alt="B"></p>\n<figure><figcaption>C</figcaption></figure>',
      );
    });
  });
});
