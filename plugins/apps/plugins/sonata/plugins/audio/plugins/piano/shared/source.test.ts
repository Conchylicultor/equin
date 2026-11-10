import { expect, test } from "bun:test";
import { LAYERS } from "smplr";
import { pianoSource } from "./source";

test("the pinned samples are exactly the ones smplr's LAYERS requests, in both formats", () => {
  // smplr's loader dedupes `region.sample` across every velocity layer and
  // fetches each as `<baseUrl>/<name>.<ogg|m4a>` (the format it negotiates).
  const names = [
    ...new Set(LAYERS.flatMap((l) => l.samples.map((s) => String(s[1])))),
  ];
  expect(Object.keys(pianoSource.files).sort()).toEqual(
    names.flatMap((n) => [`${n}.ogg`, `${n}.m4a`]).sort(),
  );
});
