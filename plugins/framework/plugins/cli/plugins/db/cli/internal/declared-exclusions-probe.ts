import { writeFileSync } from "node:fs";
import { readNamespaceArgv } from "@plugins/infra/plugins/runtime-identity/core";
import { installDeclaredListEntries } from "@plugins/framework/plugins/server-core/cli";
import { forkExclusions } from "@plugins/database/plugins/admin/server";

// Spawned by `../fork.ts` (never imported): reads the fork exclusions the
// checkout of `--namespace <ns>` declares — two data lists, so from what the
// build wrote down for that namespace's registry, as every host reads them,
// with no plugin loaded — and writes them, as JSON, to `--out <file>`.
//
// A process of its own because reading the registry means declaring a runtime
// namespace (it selects the registry), and the
// `db fork` process must not have one: with a namespace, its own database
// connections would claim to report their ends through sinks nothing in a CLI
// drains (`database/connection`'s `hasRuntimeNamespace()` reads).
//
// The answer goes to a file, not stdout, so nothing a module prints while the
// graph loads can be mistaken for it. Exits explicitly: a loaded module may
// hold a handle open, and this process has nothing left to do.

const namespace = readNamespaceArgv(process.argv);
const outAt = process.argv.indexOf("--out");
const out = outAt === -1 ? undefined : process.argv[outAt + 1];
if (namespace === undefined || out === undefined) {
  throw new Error(
    "declared-exclusions-probe: usage: --namespace <ns> --out <file> (spawned by `./equin db fork`).",
  );
}
await installDeclaredListEntries(namespace);
const exclusions = forkExclusions();
writeFileSync(out, JSON.stringify(exclusions));
process.exit(0);
