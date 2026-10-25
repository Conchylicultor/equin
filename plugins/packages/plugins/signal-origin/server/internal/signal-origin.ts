import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { dlopen, ptr } from "bun:ffi";
import type { Ready } from "@plugins/infra/plugins/deps/deps";
import {
  builtFile,
  type BuildSource,
} from "@plugins/infra/plugins/deps/plugins/build/deps";
import type { SignalOrigin } from "../../core";

/**
 * Must match `SO_LAYOUT_VERSION` in `native/signal-origin.c`. The shim's
 * identity includes the `.c` source's hash, so a stale build can only ever
 * pair with matching TS — but this is the cheap explicit guard that turns a
 * hypothetical skew into a refused arm instead of a mis-parsed record.
 */
const EXPECTED_LAYOUT_VERSION = 1;

/** Generous: the JSON is ~200 bytes plus one 4 KB path, worst case. */
const SNAPSHOT_BUF_BYTES = 16 * 1024;

/**
 * Arming either worked, or it did not and says why.
 *
 * A bare `false` would be an absorbable failure here: the caller's whole job on
 * the unarmed path is to record `{armed:false, reason}` so that the *absence*
 * of attribution is itself on the record — "no sender recorded" must never be
 * confusable with "nobody sent a signal".
 */
export type SignalOriginArmResult =
  { armed: true; libraryPath: string } | { armed: false; reason: string };

interface TapSymbols {
  so_install: (signo: number) => number;
  so_snapshot: (signo: number, buf: unknown, cap: number) => number;
  so_layout_version: () => number;
}

let tap: TapSymbols | null = null;
/** Sticky: once arming has failed, every later call fails the same way without retrying the `dlopen`. */
let armResult: SignalOriginArmResult | null = null;

/**
 * Whether the escape hatch turns the whole mechanism off host-wide
 * (`EQUIN_NO_SIGNAL_ORIGIN=1`, mirroring EQUIN_NO_SPAWN_PRIORITY):
 * no arm, and a caller ensuring the shim should not build it either.
 */
export function signalOriginDisabled(): boolean {
  return readEnv("NO_SIGNAL_ORIGIN") === "1";
}

/**
 * `dlopen` LAZILY on first arm rather than at module eval — same two reasons as
 * `packages/flock`: this module is reachable from the CLI bootstrap, and a
 * module-eval `dlopen` would break every non-FFI consumer (type-only imports,
 * tooling, docgen).
 */
function loadTap(
  libraryPath: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  try {
    const { symbols } = dlopen(libraryPath, {
      so_install: { args: ["i32"], returns: "i32" },
      so_snapshot: { args: ["i32", "ptr", "i32"], returns: "i32" },
      so_layout_version: { args: [], returns: "u32" },
    });
    const loaded = symbols as unknown as TapSymbols;
    const version = loaded.so_layout_version();
    if (version !== EXPECTED_LAYOUT_VERSION) {
      return {
        ok: false,
        reason: `layout version ${version}, expected ${EXPECTED_LAYOUT_VERSION}`,
      };
    }
    tap = loaded;
    return { ok: true, path: libraryPath };
    // Fail-open by contract: a dlopen/symbol failure on a future OS degrades to
    // "no attribution", it never aborts the caller's startup.
  } catch (err) {
    return { ok: false, reason: `dlopen failed: ${String(err)}` };
  }
}

/**
 * Arm the tap for each signal number in `signos`, from the shim `ready` names
 * (`ensureDep(signalOriginShim, …)` — this plugin's `deps/` barrel — is the
 * only way to get one, so "armed without building" is a type error).
 *
 * ORDERING IS LOAD-BEARING: call this AFTER `process.on(sig, …)` for every
 * signal you pass. Bun installs its own handler lazily, on the first
 * `process.on(sig)`, and does not chain — so arming first would be silently
 * overwritten by Bun and the tap would never see a delivery.
 *
 * Fails open and QUIET. A `dlopen` failure, a layout mismatch or a refused `sigaction` all return
 * `{armed:false, reason}` and change nothing about how the process handles
 * signals. Nothing is printed: a banner on every build in a toolchain-less
 * environment would be noise in exactly the transcript this feature exists to
 * keep clean. Recording the reason is the caller's job — including a shim
 * that could not be built, which never reaches here (no `Ready`).
 */
export function armSignalOrigin(
  shim: Ready<BuildSource>,
  signos: number[],
): SignalOriginArmResult {
  // A failure is sticky — never re-`dlopen` per call. A success is not: a later
  // caller may pass signals the first one did not, and `so_install` is
  // idempotent, so arming more is free.
  if (armResult !== null && !armResult.armed) return armResult;
  if (signalOriginDisabled()) {
    armResult = {
      armed: false,
      reason: `disabled by ${envName("NO_SIGNAL_ORIGIN")}=1`,
    };
    return armResult;
  }

  const loaded = loadTap(builtFile(shim));
  if (!loaded.ok) {
    armResult = { armed: false, reason: loaded.reason };
    return armResult;
  }
  const symbols = tap;
  if (symbols === null) {
    armResult = { armed: false, reason: "tap not loaded" };
    return armResult;
  }

  const failed: number[] = [];
  for (const signo of signos) {
    if (symbols.so_install(signo) !== 0) failed.push(signo);
  }
  // All-or-nothing: a partial arm is a slot that silently never fills, which is
  // the failure mode this whole plugin exists to eliminate.
  armResult =
    failed.length === 0
      ? { armed: true, libraryPath: loaded.path }
      : {
          armed: false,
          reason: `so_install refused signal(s) ${failed.join(",")}`,
        };
  return armResult;
}

/**
 * The recorded origin of the last `signo` delivery, or `null` when the tap is
 * not armed or no such signal ever arrived.
 *
 * Synchronous and pure-read: safe to call from a `process.on("exit")` hook,
 * where no async work can run. Pulling from here rather than pushing from the
 * handler is what makes the record survive a signal that arrives while the
 * process is blocked in a synchronous FFI call — the slot is populated for
 * whichever exit path eventually runs.
 */
export function readSignalOrigin(signo: number): SignalOrigin | null {
  if (tap === null || armResult === null || !armResult.armed) return null;
  const buf = new Uint8Array(SNAPSHOT_BUF_BYTES);
  const n = tap.so_snapshot(signo, ptr(buf), buf.length);
  // 0 = nothing recorded for this signal; negative = bad args / seqlock churn /
  // truncation. Both are "no attribution available", which the caller already
  // handles — there is nothing partial to hand back.
  if (n <= 0) return null;
  const json = new TextDecoder().decode(buf.subarray(0, n));
  return JSON.parse(json) as SignalOrigin;
}
