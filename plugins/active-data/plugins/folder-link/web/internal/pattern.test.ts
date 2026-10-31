import { describe, expect, test } from "bun:test";
import { parseFileLinks } from "@plugins/primitives/plugins/file-links/web";
import { FOLDER_PATH_RE } from "./pattern";

/** The file links render `text` as one file path, whole. */
function fileFullMatch(text: string): boolean {
  const segments = parseFileLinks(text);
  return (
    segments.length === 1 &&
    segments[0]?.type === "path" &&
    segments[0].value === text
  );
}

describe("FOLDER_PATH_RE", () => {
  test.each([
    "~/Downloads/showcase/",
    "~/Downloads/showcase",
    "~/Downloads",
    "~/.config/",
    "/tmp/out",
    "/tmp/",
    "plugins/apps/",
    "plugins/apps/plugins/file-explorer",
    "~/.config/some-app/att-1793452783-x2zjfh",
  ])("matches %s", (text) => {
    expect(FOLDER_PATH_RE.test(text)).toBe(true);
  });

  test.each([
    "/",
    "~/",
    "~",
    "showcase",
    "research/foo.md",
    "~/.zshrc",
    "docker/Dockerfile",
    "Makefile",
    "../foo",
    "./foo",
    "http://localhost:9000/agents",
    "a b/c",
    "foo.ts:148",
  ])("does not match %s", (text) => {
    expect(FOLDER_PATH_RE.test(text)).toBe(false);
  });

  // The arbitration chain runs before the file-path handler: a token both
  // patterns accept would lose its file link whenever the folder claim declines.
  test.each([
    "research/foo.md",
    "~/.zshrc",
    "~/.config/some-app/central.json",
    "/tmp/promo/video.webm",
    "docker/Dockerfile",
    "src/Makefile",
  ])("leaves the file path %s to the file links", (text) => {
    expect(fileFullMatch(text)).toBe(true);
    expect(FOLDER_PATH_RE.test(text)).toBe(false);
  });
});
