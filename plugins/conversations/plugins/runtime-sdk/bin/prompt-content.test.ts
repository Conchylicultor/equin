import { describe, expect, test } from "bun:test";
import { promptContent } from "./prompt-content";

const ID = "72d88753-c48f-47b8-bb96-374327ca1d22";
const pngPath = `/home/u/.equin/state/attachments/${ID}.png`;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("promptContent", () => {
  test("a prompt without attached images stays its text", () => {
    expect(promptContent("hello @/tmp/x.png", () => PNG)).toBe(
      "hello @/tmp/x.png",
    );
  });

  test("an attached image rides as a block after the text, its path kept", () => {
    const text = `see @${pngPath} and @${pngPath} `;
    expect(promptContent(text, () => PNG)).toEqual([
      { type: "text", text },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(PNG).toString("base64"),
        },
      },
    ]);
  });

  test("a file gone or in a format the model does not read stays a path", () => {
    const text = `see @${pngPath} `;
    expect(promptContent(text, () => null)).toBe(text);
    expect(promptContent(text, () => Uint8Array.from([1, 2, 3, 4]))).toBe(text);
  });

  test("a non-image attachment is not sent as an image", () => {
    const text = `read @/home/u/.equin/state/attachments/${ID}.pdf `;
    expect(promptContent(text, () => PNG)).toBe(text);
  });
});
