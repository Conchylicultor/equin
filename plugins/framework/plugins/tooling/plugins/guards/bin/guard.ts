#!/usr/bin/env bun
// The PreToolUse hook's entry point: a bootstrap that imports nothing from the
// repo, then loads the guard proper (`./hook`) dynamically — so a checkout
// whose code is mid-edit (a re-export of a removed name anywhere in the guard's
// import closure) gets main's guards with a notice instead of a hook that
// refuses every call, including the edit that would fix it.
// See "The guard survives a broken checkout" in ../CLAUDE.md.
import {
  assertCheckoutInstalled,
  mainCheckoutFallback,
  runGuardWithFallback,
} from "./bootstrap";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const raw = Buffer.concat(chunks).toString("utf8");

const result = await runGuardWithFallback({
  // An uninstalled checkout is a live failure with a named reason, so main's
  // guard runs instead of this one on main's packages.
  live: async () => {
    assertCheckoutInstalled(import.meta.path);
    return (await import("./hook")).guardHook(raw);
  },
  fallback: () => mainCheckoutFallback(import.meta.path, raw),
});
if (result.ok) {
  process.stdout.write(result.stdout);
} else {
  process.stderr.write(`${result.stderr}\n`);
  process.exitCode = 1;
}
