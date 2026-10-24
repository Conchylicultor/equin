import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { DepRowSchema } from "./dep-state";

/**
 * Every dependency this backend declares, with its state on this machine.
 *
 * Pushed: the server watches the deps cache directory, which the installing
 * process (a supervised child, or a `./equin deps` command) writes, and
 * re-reads on every change. Reading it never starts an install.
 */
export const depsStates = liveValue("deps.states", {
  schema: wholeList(DepRowSchema, {
    reason:
      "one row per optional dependency the code declares — a closed handful (browsers, python envs, toolchains)",
  }),
});

/**
 * Ask for a dependency to be installed. Returns at once: the install runs in
 * the `deps.install` supervised job, never on the backend's event loop, and its
 * progress shows on `deps.states`.
 */
export const installDepEndpoint = defineEndpoint({
  route: "POST /api/deps/install",
  body: z.object({ id: z.string() }),
  response: z.object({ id: z.string() }),
});

/**
 * Remove a dependency's install at its current identity, putting it back to
 * `absent`. Refused (409) while an install of it holds the lock.
 */
export const removeDepEndpoint = defineEndpoint({
  route: "POST /api/deps/remove",
  body: z.object({ id: z.string() }),
  response: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("removed"), bytes: z.number().int() }),
    z.object({ kind: z.literal("absent") }),
  ]),
});
