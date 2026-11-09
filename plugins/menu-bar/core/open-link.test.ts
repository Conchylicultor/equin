import { describe, expect, test } from "bun:test";
import { openLink } from "./open-link";

describe("openLink", () => {
  // The same page `rust/src/open_link.rs`'s `reads_the_page` parses back.
  test("encodes the whole page as one url parameter", () => {
    expect(
      openLink("http://equin.localhost:9000/files/computer/at/~%2F__A__"),
    ).toBe(
      "equin://open?url=http%3A%2F%2Fequin.localhost%3A9000%2Ffiles%2Fcomputer%2Fat%2F~%252F__A__",
    );
    expect(openLink("https://equin.localhost:9000/mail?q=1&x=2")).toBe(
      "equin://open?url=https%3A%2F%2Fequin.localhost%3A9000%2Fmail%3Fq%3D1%26x%3D2",
    );
  });
});
