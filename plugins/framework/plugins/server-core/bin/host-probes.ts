import {
  installAsleepClock,
  installHeapReader,
  installMemoryProbe,
  installPeerMemoryProbe,
  installSnapHash,
} from "@plugins/framework/plugins/server-core/core";
import { readSleepClock } from "@plugins/packages/plugins/sleep-clock/core";
import { macPeerProcMemory, macProcMemory } from "./phys-footprint";

// ── The desktop host's native probes, installed into the portable `core` ─────
//
// `core` runs on every host, so what only this host can do — read macOS
// phys_footprint and the sleep clock over bun:ffi, hash with `Bun.hash` — is
// installed into it from here, the desktop's own entry folder, before the
// plugin graph boots. Imported
// for its side effect by both boot modes before booting — `serve` (`./serve.ts`)
// statically, `exec` through `./active-runtime` dynamically — so neither mode
// can boot without them.

installMemoryProbe(macProcMemory);
installPeerMemoryProbe(macPeerProcMemory);
installHeapReader(() => process.memoryUsage());
// Native wyhash on the keyed-delta hot path (the runtime's portable default is
// plain-JS `hash64`); the length fold kills every different-length collision.
installSnapHash((json) => Bun.hash.wyhash(json) ^ BigInt(json.length));
// The sleep clock, so `_debug.linger` can say whether a linger spanned a sleep.
installAsleepClock(() => {
  const r = readSleepClock();
  return r.supported ? r.asleepMs : null;
});
