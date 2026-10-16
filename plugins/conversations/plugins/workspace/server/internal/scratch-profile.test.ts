import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  defineScratchProfile,
  resetScratchProfiles,
  ScratchProfile,
} from "./scratch-profile";

const hello = defineScratchProfile({
  id: "test.hello",
  label: "Hello",
  description: "test",
  inputSchema: z.object({ note: z.string() }),
  instructions: (input) => `note: ${input.note}`,
  mcpTools: ["flag_raise"],
});

beforeEach(resetScratchProfiles);

describe("ScratchProfile registry", () => {
  test("define registers on the register phase", async () => {
    const token = ScratchProfile.define(hello);
    expect(() => ScratchProfile.get("test.hello")).toThrow(
      'Unknown scratch profile "test.hello"',
    );
    await token.register();
    expect(ScratchProfile.get("test.hello").mcpTools).toEqual(["flag_raise"]);
    expect(ScratchProfile.all().map((p) => p.id)).toEqual(["test.hello"]);
  });

  test("a second profile with one id throws", async () => {
    await ScratchProfile.define(hello).register();
    expect(() => ScratchProfile.define(hello).register()).toThrow(
      'Scratch profile "test.hello" already registered',
    );
  });
});
