import rule from "./no-raw-media-play";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const FILE = "/repo/plugins/foo/web/components/x.tsx";

ruleTester.run("no-raw-media-play", rule, {
  valid: [
    { code: `void playMedia(el);`, filename: FILE },
    // An Animation's or a controller's play() returns nothing to chain.
    { code: `for (const a of animations) a.play();`, filename: FILE },
    { code: `controller.play();`, filename: FILE },
    { code: `player.play(song);`, filename: FILE },
  ],
  invalid: [
    {
      code: `el.play().catch(() => undefined);`,
      filename: FILE,
      errors: [{ messageId: "noRawMediaPlay" }],
    },
    {
      code: `async function f() { await video.play(); }`,
      filename: FILE,
      errors: [{ messageId: "noRawMediaPlay" }],
    },
    {
      code: `void audio["play"]();`,
      filename: FILE,
      errors: [{ messageId: "noRawMediaPlay" }],
    },
  ],
});
