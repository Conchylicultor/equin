#!/usr/bin/env bun
// The PreToolUse hook's entry point: a bootstrap that imports nothing from the
// repo, then loads the guard proper (`./hook`) dynamically — so a checkout
// whose code is mid-edit (a re-export of a removed name anywhere in the guard's
// import closure) gets main's guards with a notice instead of a hook that
// refuses every call, including the edit that would fix it.
// See "The guard survives a broken checkout" in ../CLAUDE.md.
import {
  assertCheckoutInstalled,
  holdGuardLease,
  mainCheckoutFallback,
  runGuardWithFallback,
} from "./bootstrap";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const raw = Buffer.concat(chunks).toString("utf8");

const result = await runGuardWithFallback({
  // An uninstalled checkout is a live failure with a named reason, so main's
  // guard runs instead of this one on main's packages.
  //
  // Run from one of main's slots (a scratch agent's guards), the slot is held
  // shared while the guard loads and runs (`holdGuardLease`), so no build
  // checks it out under it; a lock that cannot be taken fails the live run.
  live: async () => {
    assertCheckoutInstalled(import.meta.path);
    const lease = holdGuardLease(import.meta.path);
    try {
      return await (await import("./hook")).guardHook(raw);
    } finally {
      lease.release();
    }
  },
  fallback: () => mainCheckoutFallback(import.meta.path, raw),
});
if (result.ok) {
  process.stdout.write(result.stdout);
} else {
  process.stderr.write(`${result.stderr}\n`);
  process.exitCode = 1;
}
