import { join } from "node:path";
import { z } from "zod";
import { defineScratchProfile } from "@plugins/conversations/plugins/workspace/server";

export const SCRATCH_HELLO = "scratch.hello";

/**
 * The smallest scratch profile: a note materialized as `note.txt`, one
 * profile-only MCP tool and `flag_raise`. For checking what a scratch agent
 * actually receives (its context, its tools, its settings) — launch it with
 * `POST /api/conversations` and
 * `{ "workspace": { "kind": "scratch", "profile": "scratch.hello", "input": {} } }`.
 */
export const scratchHelloProfile = defineScratchProfile({
  id: SCRATCH_HELLO,
  label: "Hello",
  description:
    "Debug profile: a scratch agent with a note file, one profile-only tool and flag_raise.",
  inputSchema: z.object({
    note: z.string().default("hello from scratch.hello"),
  }),
  instructions: (input) =>
    [
      "# scratch.hello",
      "",
      "You are a test agent running in a scratch workspace: this directory holds",
      "only this file and `note.txt`. It is not a git repository.",
      "",
      `Your note reads: "${input.note}".`,
      "",
      "When asked to describe your context, list every instruction file you",
      "were given, every MCP tool you can call, and call `scratch_hello_where`",
      "to report the directory the server thinks you run in.",
    ].join("\n"),
  mcpTools: ["scratch_hello_where", "flag_raise"],
  permissions: { allow: ["Read", "Write", "Edit"] },
  async prepare({ dir, input }) {
    await Bun.write(join(dir, "note.txt"), `${input.note}\n`);
  },
});
