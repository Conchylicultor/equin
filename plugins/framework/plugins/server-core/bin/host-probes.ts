import {
  installHeapReader,
  installMemoryProbe,
  installSnapHash,
} from "@plugins/framework/plugins/server-core/core";
import { macProcMemory } from "./phys-footprint";

// ── The desktop host's native probes, installed into the portable `core` ─────
//
// `core` runs on every host, so what only this host can do — read macOS
// phys_footprint over bun:ffi, hash with `Bun.hash` — is installed into it from
// here, the desktop's own entry folder, before the plugin graph boots. Imported
// for its side effect by `./active-runtime`, which both boot modes load before
// booting (`serve` statically, `exec` dynamically), so neither mode can boot
// without them.

installMemoryProbe(macProcMemory);
installHeapReader(() => process.memoryUsage());
// Native wyhash on the keyed-delta hot path (the runtime's portable default is
// plain-JS `hash64`); the length fold kills every different-length collision.
installSnapHash((json) => Bun.hash.wyhash(json) ^ BigInt(json.length));
