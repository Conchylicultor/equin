import { describe, expect, test } from "bun:test";
import { extractVisibleText } from "./page-text";
import { readCappedBody, readPage, type FetchedPage } from "./probe";

// The byte cap is the probe's only bound on a stranger's server: without it a
// mistyped URL pointing at a large file is an unbounded download every tick.

function stream(text: string, chunkSize = 16): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

describe("readCappedBody", () => {
  test("stops at the cap, mid-chunk, and says so", async () => {
    const body = await readCappedBody(stream("x".repeat(10_000)), 200);
    expect(body.bytes.byteLength).toBe(200);
    expect(body.truncated).toBe(true);
  });

  test("returns the whole body when it fits", async () => {
    const body = await readCappedBody(stream("hello"), 200);
    expect(new TextDecoder().decode(body.bytes)).toBe("hello");
    expect(body.truncated).toBe(false);
  });

  test("a body of exactly the cap is whole, not truncated", async () => {
    // The off-by-one that makes `truncated` worth trusting: without reading one
    // byte past the cap, this case is indistinguishable from a cut body and
    // would park a healthy source.
    const body = await readCappedBody(stream("x".repeat(200), 64), 200);
    expect(body.bytes.byteLength).toBe(200);
    expect(body.truncated).toBe(false);
  });

  test("its output feeds the rewriter", async () => {
    // Regression pin: the capping used to be a piped `TransformStream`, which
    // Bun's `HTMLRewriter.transform()` refuses (`ERR_STREAM_CANNOT_PIPE`). A
    // truncated document must also parse rather than throw.
    const html = `<html><body><nav>Menu</nav>${"<p>Techno Night</p>".repeat(500)}`;
    const body = await readCappedBody(stream(html, 64), 256);
    const page = await extractVisibleText(
      new Response(body.bytes, { headers: { "content-type": "text/html" } }),
      1_000_000,
    );
    expect(page.text).toContain("Techno Night");
    expect(page.text).not.toContain("Menu");
  });

  test("a byte cap landing in <head> reports truncation rather than a title-only page", async () => {
    // The fitzroy-paris.com regression, in miniature: the readable content sits
    // behind a wall of inline CMS <style>, so a markup-offset cap cuts the
    // document before <body>. What must NOT happen is a clean, plausible,
    // event-free page — that is what makes the engine delete the user's events.
    const html =
      `<html><head><title>Soirées</title><style>${"a{color:#fff}".repeat(400)}</style></head>` +
      `<body><p>Techno Night — 25 August</p></body></html>`;
    const body = await readCappedBody(stream(html, 64), 1024);

    expect(body.truncated).toBe(true);
    const page = await extractVisibleText(
      new Response(body.bytes, { headers: { "content-type": "text/html" } }),
      1_000_000,
    );
    expect(page.text).not.toContain("Techno Night");
    expect(page.text).toBe("Soirées");
  });
});

// `readPage` is the half that decides whether a page is safe to hand the model,
// and it takes no network — which is exactly why it can be pinned here, over a
// literal `FetchedPage`, including the cases that only ever arrive from a
// stranger's server.

const TARGET = new URL("https://venue.example/events");

function fetched(html: string, over: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: TARGET.toString(),
    bytes: new TextEncoder().encode(html) as Uint8Array<ArrayBuffer>,
    contentType: "text/html; charset=utf-8",
    via: "plain",
    truncated: false,
    ...over,
  };
}

describe("readPage", () => {
  test("reads the same page identically whichever transport fetched it", async () => {
    // The invariant the whole restructure exists for: starting a browser changes
    // how the bytes were obtained, never what the page means. Same bytes ⇒ same
    // fingerprint ⇒ no extraction is paid for on a mode flip alone.
    const html =
      "<html><body><ul><li>Techno Night — 25 August</li></ul></body></html>";
    const plain = await readPage(fetched(html), TARGET);
    const browser = await readPage(fetched(html, { via: "browser" }), TARGET);

    expect(plain.fingerprint).toBe(browser.fingerprint);
    expect(plain.payload.text).toBe(browser.payload.text);
    expect(plain.payload.html).toBe(browser.payload.html);
  });

  test("a page with no readable text at all throws instead of becoming an empty listing", () => {
    // The destructive case this guard exists for: the model would be shown an
    // empty page, truthfully answer `{"events": []}`, and `runSource` would stamp
    // `disappearedAt` on every event the source ever found.
    const shell =
      "<html><body><div id='root'></div><script>render()</script></body></html>";
    expect(readPage(fetched(shell), TARGET)).rejects.toThrow(
      "no readable text",
    );
  });

  test("the empty-page remedy differs by transport, because the user's next move does", () => {
    const shell = "<html><body><div id='root'></div></body></html>";

    expect(readPage(fetched(shell), TARGET)).rejects.toThrow(
      '"Browser render"',
    );

    // A real browser already ran the page's JavaScript, so there is no mode to
    // suggest — this is the cookie/sign-in-wall outcome.
    const browser = readPage(fetched(shell, { via: "browser" }), TARGET);
    expect(browser).rejects.toThrow("cookie or sign-in wall");
    expect(browser).rejects.not.toThrow('"Browser render"');
  });

  test("readability is a fact, not a threshold — one word is a readable page", async () => {
    // Deliberately NOT "fewer than N characters ⇒ it did not render": a venue
    // genuinely between seasons is a short page, and parking it would be wrong.
    const thin = "<html><body><p>Rien de prévu</p></body></html>";
    const result = await readPage(fetched(thin), TARGET);
    expect(result.payload.text).toBe("Rien de prévu");
  });

  test("whitespace-only markup counts as no readable text", () => {
    expect(
      readPage(fetched("<html><body>   <br>\n\t </body></html>"), TARGET),
    ).rejects.toThrow("no readable text");
  });

  test("a page flagged not-whole throws before anything is read from it", () => {
    // Both transports raise the same flag for their own reason (a cancelled
    // reader, an oversized render) and both land on the same refusal: never a
    // shorter page.
    expect(
      readPage(
        fetched("<html><body><p>Techno Night</p></body></html>", {
          truncated: true,
          via: "browser",
        }),
        TARGET,
      ),
    ).rejects.toThrow("cannot be read whole");
  });

  test("the payload carries the post-redirect URL, not the configured one", async () => {
    const page = fetched("<html><body><p>Techno Night</p></body></html>", {
      url: "https://venue.example/en/events",
    });
    const result = await readPage(page, TARGET);
    expect(result.payload.url).toBe("https://venue.example/en/events");
  });
});
