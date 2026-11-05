// The child that records a Playwright browser install's executables, run by
// path by the playwright-browser kind's `install` (never imported). It asks
// Playwright's own registry — loaded from `coreBundle`, with
// `PLAYWRIGHT_BROWSERS_PATH` set to the install's dir by the parent — for the
// headed and headless-shell executables, and writes what it answers to `out`.
//
// A file rather than a `bun -e` string: the string held a `require(b)` that
// every closure reaching the kind carried as a load by computed path, which
// `sourceDigest` (and `boot:closure-digestable`) cannot follow. A child run by
// path is not code the parent loads.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const [coreBundle, out, playwrightCore] = process.argv.slice(2);
if (!coreBundle || !out || !playwrightCore) {
  throw new Error(
    "usage: record-executables.ts <playwright-core coreBundle> <out.json> <playwright-core version>",
  );
}
const registry = (
  createRequire(import.meta.url)(coreBundle) as {
    registry: {
      registry: {
        findExecutable(name: string): { executablePath(): string };
      };
    };
  }
).registry.registry;
writeFileSync(
  out,
  JSON.stringify({
    playwrightCore,
    headed: registry.findExecutable("chromium").executablePath(),
    headlessShell: registry
      .findExecutable("chromium-headless-shell")
      .executablePath(),
  }),
);
