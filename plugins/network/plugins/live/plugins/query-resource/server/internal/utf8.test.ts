import { describe, expect, test } from "bun:test";
import { utf8ByteLength } from "./utf8";

describe("utf8ByteLength", () => {
  test.each([
    "",
    "abc",
    "é",
    "€",
    "😀",
    "a😀é€",
    "\ud800",
    "\udc00x",
    "x\ud800",
  ])("agrees with the encoder on %p", (s) => {
    expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).byteLength);
  });
});
