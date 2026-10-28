import { describe, expect, test } from "bun:test";
import { attachmentDiskRef, attachmentRefsOf } from "./attachment-refs";

const ID = "5ab235d4-8a1c-43fe-9de3-c1a3bdb5a18c";
const DIR = "/data/state/attachments";

describe("attachmentRefsOf", () => {
  test("an image disk ref reads back as its image markdown", () => {
    const sent = `See ${attachmentDiskRef(`${DIR}/${ID}.png`)}here`;
    expect(attachmentRefsOf(sent)).toBe(`See ![](/api/attachments/${ID})here`);
  });

  test("adjacent refs stay two refs", () => {
    const sent =
      attachmentDiskRef(`${DIR}/${ID}.png`) +
      attachmentDiskRef(`${DIR}/${ID}.jpg`);
    expect(attachmentRefsOf(sent)).toBe(
      `![](/api/attachments/${ID})![](/api/attachments/${ID})`,
    );
  });

  test("any other file reads back as a file ref", () => {
    expect(attachmentRefsOf(attachmentDiskRef(`${DIR}/${ID}.pdf`))).toBe(
      `[${ID}.pdf](/api/attachments/${ID})`,
    );
  });

  test("a path outside the attachments dir is left alone", () => {
    const text = `@/repo/plugins/${ID}.png and @research/x.md`;
    expect(attachmentRefsOf(text)).toBe(text);
  });
});
