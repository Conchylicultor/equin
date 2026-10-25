import { describe, expect, it } from "bun:test";
import { parseFileLinks } from "./parse";

function paths(text: string) {
  return parseFileLinks(text)
    .filter((s) => s.type === "path")
    .map((s) => (s.line != null ? `${s.value}:${s.line}` : s.value));
}

describe("parseFileLinks", () => {
  it("matches relative and home-rooted paths", () => {
    expect(paths("see docs/plugins.md and ~/.zshrc")).toEqual([
      "docs/plugins.md",
      "~/.zshrc",
    ]);
  });

  it("matches an absolute path, line suffix included", () => {
    expect(paths("File: /tmp/equin-promo/equin-promo.webm (16 MB)")).toEqual([
      "/tmp/equin-promo/equin-promo.webm",
    ]);
    expect(paths("/srv/repo/src/a.ts:12")).toEqual(["/srv/repo/src/a.ts:12"]);
  });

  it("leaves the path of a URL inside the URL", () => {
    const segs = parseFileLinks("open https://example.com/a/b.png now");
    expect(segs.map((s) => s.type)).toEqual(["text", "url", "text"]);
    expect(paths("localhost:9000/plugins/foo.ts")).toEqual([]);
  });
});
