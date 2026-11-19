import { useEffect, useMemo } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import type { ShortcutDescriptor } from "./types";
import { registerShortcuts } from "./dynamic-registry";

type CallerDescriptor = Omit<ShortcutDescriptor, "surfaceId">;

/**
 * What a set of shortcuts IS — every field the registry arbitrates by, in
 * order — without the closures. Two renders building the same shortcuts with
 * fresh `handler` / `when` closures share it.
 */
function registrationKey(
  descriptors: readonly CallerDescriptor[],
  surfaceId: string | undefined,
): string {
  return JSON.stringify([
    surfaceId ?? null,
    descriptors.map((d) => [
      d.id,
      d.keys,
      d.label,
      d.group ?? null,
      d.precedence ?? 0,
      d.enableInInputs === true,
      d.when !== undefined,
    ]),
  ]);
}

/**
 * Registers `descriptors` with the dynamic registry for as long as the caller
 * is mounted — tagged with `surfaceId` (surface-scoped, ids suffixed so two
 * surfaces never collide) or global when it is `undefined`.
 *
 * Registered by what the shortcuts are, not by the array's identity: the
 * registry changes (and the manager re-renders) only when an id, a combo, a
 * label or an arbitration field changes. `handler` and `when` are read from
 * the latest render at the keystroke, so a caller rebuilding its array (and
 * its closures) on every render costs nothing — a surface re-rendering per
 * frame once re-registered per frame, every registration a commit of the
 * manager (the demo's Places, 41/s during a window resize).
 */
export function useRegisteredShortcuts(
  descriptors: readonly CallerDescriptor[],
  surfaceId: string | undefined,
): void {
  const key = registrationKey(descriptors, surfaceId);
  const latest = useLatestRef({ key, descriptors });
  const registered = useMemo((): ShortcutDescriptor[] => {
    const captured = descriptors;
    // The closures to call: the latest render's while it has this very shape
    // (same key: same shortcuts, same order), else the ones this registration
    // was made with — a render that changed the shape (a shortcut dropped, the
    // views reordered) and has not committed yet, or never will, must not
    // hand index `i` another shortcut's handler.
    const current = (i: number): CallerDescriptor =>
      latest.current.key === key
        ? latest.current.descriptors[i]!
        : captured[i]!;
    return captured.map((d, i) => ({
      id: surfaceId === undefined ? d.id : `${d.id}:${surfaceId}`,
      keys: d.keys,
      label: d.label,
      ...(d.group === undefined ? {} : { group: d.group }),
      ...(d.precedence === undefined ? {} : { precedence: d.precedence }),
      ...(d.enableInInputs === undefined
        ? {}
        : { enableInInputs: d.enableInInputs }),
      ...(surfaceId === undefined ? {} : { surfaceId }),
      handler: () => current(i).handler(),
      ...(d.when === undefined
        ? {}
        : {
            when: (event: KeyboardEvent) => current(i).when?.(event) ?? true,
          }),
    }));
    // `key` is the trigger (it spells `descriptors`' shape and `surfaceId`);
    // `latest` carries the closures of every later render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, latest]);
  useEffect(() => registerShortcuts(registered), [registered]);
}
