import { describe, expect, test } from "bun:test";
import { simplifyPageHtml } from "./page-html";

// What the model reads. The property under test throughout is that GROUPING
// survives — the thing flat text cannot express and the reason this file exists.

describe("simplifyPageHtml — structure", () => {
  test("keeps the element boundary that says which fields are one event", () => {
    const html = simplifyPageHtml(
      `<ul>
         <li><h3>Techno Night</h3><p>25 August</p><p>Fitzroy</p></li>
         <li><h3>Jazz Brunch</h3><p>9 August</p><p>Le Perchoir</p></li>
       </ul>`,
    );
    // Each card is one <li>: "25 August" cannot be read as Jazz Brunch's date.
    expect(html).toBe(
      "<ul><li><h3>Techno Night</h3><p>25 August</p><p>Fitzroy</p></li>" +
        "<li><h3>Jazz Brunch</h3><p>9 August</p><p>Le Perchoir</p></li></ul>",
    );
  });

  test("keeps table geometry, which flat text collapses into an ambiguous run", () => {
    const html = simplifyPageHtml(
      `<table><tr><td>Sam 12</td><td>PSG–OM</td><td>21:00</td></tr>
              <tr><td>Dim 13</td><td>Lyon–Nice</td><td>17:00</td></tr></table>`,
    );
    expect(html).toContain("<tr><td>Sam 12</td><td>PSG–OM</td><td>21:00</td></tr>");
    expect(html).toContain("<tr><td>Dim 13</td><td>Lyon–Nice</td><td>17:00</td></tr>");
  });

  test("keeps the machine-readable instant and the link, which text discards", () => {
    const html = simplifyPageHtml(
      `<a href="/blind-test"><time datetime="2026-08-25T22:00:00+02:00">mar. 25 août</time></a>`,
    );
    expect(html).toContain(`href="/blind-test"`);
    expect(html).toContain(`datetime="2026-08-25T22:00:00+02:00"`);
  });

  test("infers omitted end tags, which a token rewriter cannot", () => {
    // Real pages write this. Without spec tree construction the two items run
    // together and the card boundary — the whole point — is lost.
    expect(simplifyPageHtml(`<ul><li>Techno<li>Jazz</ul>`)).toBe(
      "<ul><li>Techno</li><li>Jazz</li></ul>",
    );
  });
});

describe("simplifyPageHtml — reduction", () => {
  test("collapses a chain of generic wrappers around a single child", () => {
    expect(simplifyPageHtml(`<div><div><div><h2>Soirées</h2></div></div></div>`)).toBe(
      "<h2>Soirées</h2>",
    );
  });

  test("does not collapse a wrapper that groups more than one child", () => {
    expect(simplifyPageHtml(`<div><h2>Soirées</h2><p>25 August</p></div>`)).toBe(
      "<div><h2>Soirées</h2><p>25 August</p></div>",
    );
  });

  test("does not collapse an <li>, a heading or a link", () => {
    // These ARE the signal — collapsing them would undo the point of the file.
    expect(simplifyPageHtml(`<ul><li><h3>Techno</h3></li></ul>`)).toBe(
      "<ul><li><h3>Techno</h3></li></ul>",
    );
    expect(simplifyPageHtml(`<a href="/x"><div>Book</div></a>`)).toContain("<a href=");
  });

  test("does not collapse a wrapper carrying a kept attribute", () => {
    expect(simplifyPageHtml(`<div itemprop="event"><p>Techno</p></div>`)).toBe(
      `<div itemprop="event"><p>Techno</p></div>`,
    );
  });

  test("drops chrome, code and empty spacer elements", () => {
    const html = simplifyPageHtml(
      `<html><head><title>T</title><style>.a{color:red}</style></head><body>
         <nav><a href="/">Home</a></nav>
         <script>window.__ADS = 1;</script>
         <div></div><div><div></div></div>
         <p>Techno Night</p>
         <footer>© 2026 — private hire</footer>
       </body></html>`,
    );
    expect(html).toBe("<p>Techno Night</p>");
  });

  test("unwraps inline typography so a split title stays one string", () => {
    expect(simplifyPageHtml(`<h3>Techno <span>Night</span></h3>`)).toBe(
      "<h3>Techno Night</h3>",
    );
  });

  test("drops presentational attributes but keeps the semantic ones", () => {
    const html = simplifyPageHtml(
      `<div class="css-1x9f" id="n7" data-hook="q" style="color:red" href="/keep">x</div>`,
    );
    expect(html).toBe(`<div href="/keep">x</div>`);
  });

  test("drops an image repeated for art direction", () => {
    // Responsive CMS templates emit the same <img> two or three times; once the
    // class/srcset churn is gone they are literally the same node.
    expect(
      simplifyPageHtml(`<div><img src="/a.png" alt="BLIND TEST"><img src="/a.png" alt="BLIND TEST"></div>`),
    ).toBe(`<img src="/a.png" alt="BLIND TEST">`);
  });

  test("drops an art-direction copy that only becomes a sibling after collapse", () => {
    // The shape Wix actually emits: each copy in its own wrapper. Deduping
    // before the wrappers collapse sees [div, div] and finds nothing, so the
    // two passes have to run in this order.
    expect(
      simplifyPageHtml(
        `<li><div><img src="/a.png" alt="BLIND TEST"></div>` +
          `<div><img src="/a.png" alt="BLIND TEST"></div><h3>BLIND TEST</h3></li>`,
      ),
    ).toBe(`<li><img src="/a.png" alt="BLIND TEST"><h3>BLIND TEST</h3></li>`);
  });

  test("serializes void elements without a closing tag", () => {
    expect(simplifyPageHtml(`<p>a<br>b</p>`)).toBe("<p>a<br>b</p>");
  });

  test("escapes text so the markup it emits stays well-formed", () => {
    expect(simplifyPageHtml(`<p>Rock &amp; Roll &lt;3</p>`)).toBe(
      "<p>Rock &amp; Roll &lt;3</p>",
    );
  });
});
