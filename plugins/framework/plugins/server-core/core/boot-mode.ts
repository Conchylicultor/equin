// Which boot mode THIS process is in — `serve` (the gateway-spawned, long-lived
// backend) or `exec` (a short-lived child that runs one registered piece of
// work and exits). See `./boot-stages.ts` for the split.
//
// Both modes run the same `register` and `onReadyBlocking` phases, so a plugin
// whose hook in one of those phases makes a claim about the SERVING backend
// must ask. The case that forced this: boot-events wrote its `start` line from
// `register`, but its `ready` line from `onReady`, which exec skips — so every
// nightly backup child left an unpaired `start` in main's boot channel, and the
// boot watchdog reported main as wedged for as long as main then stayed up.
//
// Set once, by the shared boot sequence, before any plugin module loads — so
// every phase hook can read it, and a read before boot throws rather than
// guessing.
export type BootMode = "serve" | "exec";

let mode: BootMode | undefined;

export function setBootMode(next: BootMode): void {
  if (mode !== undefined && mode !== next) {
    throw new Error(
      `[boot] boot mode already set to "${mode}"; refusing to switch to "${next}"`,
    );
  }
  mode = next;
}

export function getBootMode(): BootMode {
  if (mode === undefined) {
    throw new Error(
      "[boot] getBootMode() read before the boot sequence set it — call it from a phase hook, not at module eval",
    );
  }
  return mode;
}

// ── The plugin being registered ─────────────────────────────────────────────
//
// Kept beside the boot mode for the same reason: its SETTER belongs to the boot
// sequence alone, so it stays off the core barrel (only the getter is exported).
//
// The register phase is sequential (`runRegisterPhase` in
// `./boot-stages.ts` awaits each token before the next), so "the plugin
// being registered" is a single well-defined value for the whole of a
// `Registration.register()` call — including an async one that awaits inner
// tokens (a wrapper registering the job it wraps). A registry records it so it
// can later say WHERE an entry was declared (the Background activity page's
// "Declared in"), without every factory taking the plugin id as an argument it
// could get wrong.
//
// `null` outside the register phase: a token registered by hand (a test calling
// `job.register()` directly) was declared by no plugin the framework knows of.
let registering: string | null = null;

/** Set by the framework around each plugin's registrations. Never call it from
 * plugin code. */
export function setRegisteringPlugin(pluginId: string | null): void {
  registering = pluginId;
}

/** The id of the plugin whose `register` tokens are being run, or `null`
 * outside the register phase. Read it inside `Registration.register()`. */
export function registeringPlugin(): string | null {
  return registering;
}
