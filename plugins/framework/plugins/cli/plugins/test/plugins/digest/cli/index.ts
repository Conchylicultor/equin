import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The whole checkout's test digests, as the `tests.checkout-digests` job
 * (`debug/tests`) reads them: its supervised child runs this command, so the
 * module graph and the record store stay in the CLI's closure, never the
 * serving backend's (`boot:closure-digestable`).
 *
 * `detachable`: a supervised child is spawned detached.
 */
export default defineCliCommand<[], { out: string; unlessTree?: string }>({
  name: "test-digest",
  description:
    "Write every test file's digest (its import closure plus its runner's inputs) for this checkout to a JSON file — what the Debug → Tests page compares harvested verdicts against",
  detachable: true,
  options: [
    {
      flags: "--out <file>",
      description: "Where to write the digests (JSON, written atomically)",
      required: true,
    },
    {
      flags: "--unless-tree <hash>",
      description:
        "Write `unchanged` instead when this checkout's tree hash is already this one",
    },
  ],
  run: () => import("./run"),
});
