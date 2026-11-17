import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A shell served without the gateway's theme fragment (a backend that has
// never booted — a first launch) paints its first frame from index.html alone:
// the global stylesheet does not block render, so the canvas's scheme must
// come from the shell itself, and agree with the scheme it hands app.css.
const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");

describe("index.html first-paint floor", () => {
  it("declares the canvas scheme it sets on <html>, without the global stylesheet", () => {
    const meta = /<meta name="color-scheme" content="([a-z ]+)" \/>/.exec(
      html,
    )?.[1];
    const attr = /setAttribute\("data-color-scheme", "([a-z]+)"\)/.exec(
      html,
    )?.[1];
    expect(meta).toBeDefined();
    expect(attr).toBeDefined();
    expect(meta).toBe(attr);
  });

  it("puts the meta before anything the browser could paint", () => {
    const meta = html.indexOf('<meta name="color-scheme"');
    expect(meta).toBeGreaterThan(-1);
    expect(meta).toBeLessThan(html.indexOf("<body"));
    expect(meta).toBeLessThan(html.indexOf("<link"));
  });
});
