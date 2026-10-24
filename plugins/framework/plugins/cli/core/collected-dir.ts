import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";

// Marks `cli` as a collected-dir runtime: codegen scans core files for this
// marker and emits `cli.generated.ts` registering every plugin's `cli/index.ts`
// (default-export `CliCommand | CliCommand[]`), exactly as `check/` works.
// Auto-discovered — a plugin shipping a `./equin <verb>` needs no codegen
// edit, no registry edit, and no change to the framework CLI.
//
// The registry exists so the command set can be ENUMERATED without the CLI
// importing every plugin: `bin/cli.ts` loads this one generated entry list and
// each entry's loader pulls exactly one plugin's `cli/` folder. That is what
// keeps `./equin <anything>` from paying for every command's
// implementation — see `core/internal/command.ts` for the declaration /
// implementation split the entry list carries.
export const cliCollectedDir = defineCollectedDir("cli");
