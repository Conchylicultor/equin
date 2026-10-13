import { useContext, useMemo } from "react";
import { contributionsOf, PluginRuntimeContext } from "./context";
import {
  recordCreatedSlot,
  slotIdFor,
} from "@plugins/framework/plugins/slot-declaration/core";
import type { Contribution } from "./types";
import type { ComponentType } from "react";
import type { SealContributions } from "./sealed-component";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

export interface Slot<P> extends SlotHandle {
  (props: P): Contribution;
  useContributions: Hook<() => SealContributions<P>[]>;
}

const EMPTY: Contribution[] = [];

/**
 * The one constructor every slot funnels through — `defineRenderSlot`,
 * `defineMountSlot`, `defineWrapperSlot` and `defineDispatchSlot` all call it,
 * and `defineOrderedDispatchSlot` wraps dispatch. So the `meta` stamped and the
 * created-set appended here cover EVERY slot that has ever been created, with
 * no registry to keep in sync. Each richer constructor overwrites `meta.kind`
 * (and `reorderable`) with its own.
 */
export function defineSlot<P>(opts?: {
  docLabel?: (props: P) => string | undefined;
}): Slot<P> {
  const slot = ((props: P) => ({
    _slot: slot,
    _doc: { label: opts?.docLabel?.(props) },
    ...props,
  })) as unknown as Slot<P>;
  slot.meta = { kind: "slot", reorderable: false };
  // DERIVED, never given. There is no id parameter, so a computed id — the
  // `` `pane.${paneId}.actions` `` that build-time scanners could not read, and
  // that no rule could keep in step with its owner — has no spelling. Reading it
  // before the declaration pass THROWS rather than yielding a plausible
  // placeholder, because a slot genuinely has no name until a plugin gives it one.
  Object.defineProperty(slot, "id", {
    enumerable: false,
    configurable: true,
    get(): string {
      if (slot._pluginId === undefined || slot._key === undefined) {
        throw new Error(
          "[slots] slot id read before any plugin declared this slot. An id is " +
            "derived from the declaring plugin's id plus its `slots` key, so it " +
            "does not exist at module eval — read it at render or build time.",
        );
      }
      return slotIdFor(slot._pluginId, slot._key);
    },
  });
  recordCreatedSlot(slot);

  slot.useContributions = () => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- method named useContributions; ESLint doesn't recognize object.useX as a hook
    const ctx = useContext(PluginRuntimeContext);
    if (!ctx) {
      throw new Error("useContributions must be used within PluginProvider");
    }
    const raw = contributionsOf(ctx, slot) ?? EMPTY;
    // eslint-disable-next-line react-hooks/rules-of-hooks -- same as above
    return useMemo(
      () =>
        raw.map(
          ({ _slot: _, ...rest }: Contribution) => rest as SealContributions<P>,
        ),
      [raw],
    );
  };

  return slot;
}

/**
 * Present a slot behind a hand-built callable — a facade that mints the same
 * contributions while deriving a field the caller should not have to restate
 * (`Apps.App` deriving the contribution id from the `AppRef`).
 *
 * Use this instead of `Object.assign(fn, { id: slot.id, … })`. Copying `id`
 * captures it at module eval, which is *before* the declaration pass that
 * settles a slot's identity — so a copied id is a snapshot of a value that was
 * not final. Worse, a facade carrying its own id looks to the declaration guard
 * like a slot in its own right, leaving the real slot behind it undeclared and
 * matched only by the coincidence that the two strings agreed.
 *
 * So the facade forwards `id` through a getter and points at its target via
 * `_slot`, which `collectSlots` follows — the plugin declares the facade, and
 * the REAL slot is what gets stamped.
 */
export function defineSlotFacade<F extends object, S extends SlotHandle>(
  fn: F,
  slot: S,
): F & S {
  // Own ENUMERABLE keys are exactly what the constructors assigned (`meta`,
  // `useContributions`, `Render`/`Dispatch`/…), never a function's intrinsic
  // `name`/`length`/`prototype`.
  for (const key of Object.keys(slot)) {
    if (key === "id") continue;
    Object.defineProperty(fn, key, {
      value: (slot as Record<string, unknown>)[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(fn, "id", {
    get: () => slot.id,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(fn, "_slot", {
    value: slot,
    enumerable: false,
    configurable: true,
  });
  return fn as F & S;
}

export const Core = {
  Root: defineSlot<{ component: ComponentType }>(),
  // Async boot-readiness tasks. App awaits every Core.Boot `run()` once, before
  // the first render, so plugins can hydrate caches (e.g. config) that the
  // initial paint depends on — replacing per-component Suspense fallbacks.
  //
  // This is a sibling to `register` (one-shot, pre-render), NOT a general
  // lifecycle hook: readiness/hydration only, run once. While tasks run, App
  // renders its boot screen naming each pending task by `label` and the time
  // waited; a task is bounded by App's deadline. `ifUnavailable` says what a
  // failed or overdue task means: `"block"` — the app cannot meaningfully
  // paint without it, so the boot screen turns into a loud error state (Retry /
  // Continue anyway) and files a report; `"continue"` — it degrades on its own,
  // so it is reported and boot proceeds without it. A task is never aborted: an
  // overdue one that later resolves lets boot continue by itself. For per-phase
  // behavior, use React's own lifecycle inside a contributed component.
  Boot: defineSlot<{
    /** What the user is waiting for, shown on the boot screen ("Boot snapshot"). */
    label: string;
    /** Whether the app may paint without this task when it fails or is overdue. */
    ifUnavailable: "block" | "continue";
    run: () => Promise<void>;
  }>(),
};

/**
 * web-sdk's own slot declaration — the `PluginDefinition.slots` contract for a
 * plugin that has no `web/index.ts` because it IS the web runtime. It declares
 * on the module the plugin system loads it from (its core barrel), and the same
 * collectors that read a plugin barrel's `default.slots` read this.
 */
export const slots = Core;
