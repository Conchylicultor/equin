import { expect, test } from "bun:test";
import { soundfontFile } from "../shared/mirror";
import { soundfontSource } from "../shared/source";
import { GM_INSTRUMENTS } from "./gm";

test("the pinned soundfonts are exactly the GM programs 1-127 this plugin contributes", () => {
  expect(Object.keys(soundfontSource.files).sort()).toEqual(
    GM_INSTRUMENTS.filter((gm) => gm.program >= 1)
      .map((gm) => soundfontFile(gm.gleitz))
      .sort(),
  );
});
