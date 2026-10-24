import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `prototype` is a GROUP: it routes and never runs. The declaration union makes
 * that exclusive — a group carries `subcommands` and cannot also carry `run` —
 * so `./equin prototype` printing its own help is a property of the shape
 * rather than a runtime check.
 *
 * Every leaf works straight against the filesystem, never over HTTP, and that
 * is the whole point of having them: the prototypes tree is host-global and
 * outside every checkout, so an agent can mint, enumerate, see which variant
 * the user picked, and read or rewind the history of mocks with no backend
 * running and nothing built.
 *
 * This file is reached on EVERY `./equin` invocation (commander needs the
 * names and flags before it can parse argv), so it imports `defineCliCommand`
 * and nothing else; `mintPrototype`, the lister, the picks and history stores sit
 * behind the dynamic `run: () => import(…)`. `cli:command-declarations-light` measures that
 * closure. The generics are pinned so this declaration is checked against each
 * implementation's default export — see `cli/core/internal/command.ts`.
 */
export default defineCliCommand({
  name: "prototype",
  description: "Throwaway UI prototype operations",
  subcommands: [
    defineCliCommand<[string | undefined], object>({
      name: "new",
      description:
        "Mint a prototype: create a freshly id'd folder in the host-global " +
        "prototypes dir holding the blank template, and print its id, path and " +
        "URL. [title] stamps the copy's <title>, which is the name every " +
        "surface displays; omit it and the card reads 'Untitled prototype' " +
        "until you write one. Needs no running backend.",
      arguments: [
        {
          name: "[title]",
          description: "display name to stamp into the prototype's <title>",
        },
      ],
      run: () => import("./new"),
    }),
    defineCliCommand<[], object>({
      name: "list",
      description:
        "List every prototype — id, title and URL, and the options the user " +
        "has picked when any differ from the defaults — read straight off the " +
        "host-global prototypes dir. Needs no running backend.",
      run: () => import("./list"),
    }),
    defineCliCommand<[string], object>({
      name: "options",
      description:
        "Show which variant of a prototype the user is looking at: each " +
        "option it declares with the value on screen (picked, or the page's " +
        "default) and its values, then the document URL of exactly that " +
        "variant and the screenshot.ts command that renders it. The picks are " +
        "the user's — one shared record every surface reads — so this is " +
        "read-only; render another variant through its URL instead. Needs no " +
        "running backend.",
      arguments: [{ name: "<id>", description: "the prototype's id" }],
      run: () => import("./options"),
    }),
    defineCliCommand<[string], { patch?: boolean }>({
      name: "log",
      description:
        "Show a prototype's version history, newest first: each version's " +
        "number, time, kind, request and agent summary, and the conversation " +
        "that recorded it. Every agent turn that changes the folder records " +
        "one. -p adds the diff each version made. Needs no running backend.",
      arguments: [{ name: "<id>", description: "the prototype's id" }],
      options: [
        {
          flags: "-p, --patch",
          description: "show the diff each version made",
        },
      ],
      run: () => import("./log"),
    }),
    defineCliCommand<[string], { message?: string }>({
      name: "checkpoint",
      description:
        "Record the prototype folder as a new version now (a 'manual' " +
        "version), if it changed since the last one. Agent turns record " +
        "versions on their own; this is for edits made outside one. Needs no " +
        "running backend.",
      arguments: [{ name: "<id>", description: "the prototype's id" }],
      options: [
        {
          flags: "-m, --message <message>",
          description: "what this version is (its subject line)",
        },
      ],
      run: () => import("./checkpoint"),
    }),
    defineCliCommand<[string, string], object>({
      name: "restore",
      description:
        "Make an older version of a prototype live again. Unsaved changes are " +
        "recorded first as a 'Before restore' version, the old files are " +
        "written back, and a 'Restored vN' version is recorded — nothing is " +
        "lost. Needs no running backend.",
      arguments: [
        { name: "<id>", description: "the prototype's id" },
        {
          name: "<version>",
          description:
            "the version to restore: vN (from `prototype log`) or a sha",
        },
      ],
      run: () => import("./restore"),
    }),
  ],
});
