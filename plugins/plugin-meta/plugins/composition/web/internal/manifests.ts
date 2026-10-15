import { useCallback } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import type { CompositionManifest } from "@plugins/plugin-meta/plugins/closure/core";
import {
  compositionsConfig,
  isCommittedSourceComposition,
  isServableCompositionId,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";

/**
 * The raw stored composition config items — `{ id, name, entryPoints,
 * selectedContributors }[]` — read reactively from the `compositions` config_v2
 * config. The Studio compositions pane lists + edits these; engine consumers go
 * through {@link useCompositionData} (which maps these to `CompositionManifest[]`).
 * Order is array position.
 */
export function useManifestItems(): CompositionManifestItem[] {
  return useConfig(compositionsConfig).manifests;
}

/**
 * The stored composition item called `name`, or `undefined` when no live
 * composition carries that name.
 *
 * A composition has two identities and consumers straddle both: the manifest
 * item's `id` (a uuid — what `comp/:id` and the serve namespace key on) and its
 * `name` (what `release --composition` takes, what `RELEASE.json` carries, and
 * therefore what every deploy row stores). The two are the same string for
 * config-authored compositions and diverge for UI-created ones, so a
 * name-keyed consumer must resolve through the list rather than assume.
 *
 * `undefined` is a real, expected answer, not an error: a deploy row's
 * composition name is validated when it is written and nothing stops a later
 * rename or delete, so callers render the dangling name honestly.
 */
export function useManifestItemByName(
  name: string,
): CompositionManifestItem | undefined {
  return useManifestItems().find((item) => item.name === name);
}

export interface ManifestActions {
  /**
   * Upsert a manifest. With `editingId` set, replaces that item's `name` /
   * `entryPoints` / `selectedContributors` in place (preserving its `id`);
   * otherwise appends a NEW item at the end of the array with a fresh `id`
   * (`crypto.randomUUID()`, the same the `list` field renderer mints on "Add").
   * Array position is the order.
   *
   * Returns the upserted item's `id` — `editingId` when replacing, the freshly
   * minted one when appending. The Studio list pane's "New" creates the row and
   * then navigates to `comp/:id`, so it needs the id the append just minted.
   *
   * **Throws for the two committed-source rows** (main's and
   * `base-exclusions`, per {@link isCommittedSourceComposition}).
   * Those two rows decide what the repo's own app contains, and that decision
   * is read from the GIT layer: codegen resolves main's closure — with the base
   * row's negatives folded in — off the committed config to emit the
   * registries and the docs. A user-layer edit to either row therefore cannot
   * move a committed registry or a committed doc; it would sit in the config
   * looking like a change and mean nothing, while this app kept rendering
   * exclusions the built app does not have. Changing what ships is an edit to
   * `plugins/plugin-meta/plugins/composition/core/config.ts` plus a build.
   *
   * Same shape as `remove` and `setServeMode`: the surfaces render those two
   * rows' entry points read-only, and this is the loud boundary beneath them,
   * never the user-facing refusal.
   */
  save(draft: CompositionManifest, editingId?: string): string;
  /**
   * Remove the item with the given `id` — **the config edit and nothing else**.
   *
   * It does NOT reclaim what the composition is serving (its namespaces,
   * databases, config dirs and dists). That deliberately lives one layer up, in
   * `useDeleteComposition`
   * (`@plugins/build/plugins/serve-composition/web`), which asks what the
   * composition owns, confirms it, reclaims it, and then calls this. Surfaces
   * that delete a composition go through that hook; this stays the pure,
   * synchronous array edit its name promises, so no caller can trigger a data
   * wipe by editing a list.
   *
   * **Throws for the two committed-source rows** (main's and
   * `base-exclusions`, per {@link isCommittedSourceComposition}). Deleting
   * either from the user config layer takes something the repo depends on out
   * of the registry — main's row is the app this repo builds, and the base row
   * carries the exclusions every composition inherits — and
   * `composition-closure` fails when the manifest does not carry exactly one of
   * each. So the write leaves a repo that no longer checks, with no runtime
   * path back to the committed default. The affordance is removed from both
   * rows rather than left to fail, so this throw is the loud boundary beneath
   * that, not the user-facing refusal: a silent no-op would leave a Delete
   * button that looks like it worked and did nothing.
   */
  remove(id: string): void;
  /**
   * Set the `serve` mode on the item with the given `id`, preserving every
   * other field. `serve` is engine-opaque config metadata (dropped by
   * `manifestItemToManifest`), so this is a config-only write: it records
   * whether the composition is meant to be live and how often it may be rebuilt
   * automatically, never a build of its own.
   *
   * **Throws for an id no serve build may ever provision a namespace for.**
   * Main's namespace belongs to the main checkout's own build, so the mode
   * means nothing there — `activatedCompositionIds` drops main whatever value
   * is stored. Same shape as `remove`: the surfaces render the control inert,
   * and this is the loud boundary under them.
   */
  setServeMode(id: string, mode: string): void;
  /**
   * Set the `home` app (a `defineApp` id; `""` = none) on the item with the
   * given `id`, preserving every other field. Engine-opaque like `serve`; read
   * by codegen when the composition is built (it becomes the deployed `/`) and
   * validated by `composition-closure`.
   *
   * **Throws for the two committed-source rows**, exactly like `save`: codegen
   * reads their home off the git layer, so a stored edit would be inert.
   */
  setHome(id: string, home: string): void;
}

export function useManifestActions(): ManifestActions {
  const items = useManifestItems();
  const setConfig = useSetConfig(compositionsConfig);

  const save = useCallback(
    (draft: CompositionManifest, editingId?: string) => {
      // Keyed on which config layer owns the row, not on servability: the
      // reason these two cannot be written at runtime is "codegen reads the git
      // layer, so a stored edit could never reach a registry" — and it is the
      // same predicate the read-only entry-point surfaces read.
      if (editingId !== undefined && isCommittedSourceComposition(editingId)) {
        throw new Error(
          `Cannot edit the "${editingId}" composition at runtime — it decides what the app ships, ` +
            `and codegen reads the committed config, so a stored edit would be silently inert. ` +
            `Edit plugins/plugin-meta/plugins/composition/core/config.ts and rebuild.`,
        );
      }

      const fields = {
        name: draft.name,
        // Stored as plain `string[]` (config_v2 string-list). `PluginId` is a
        // branded string, so it widens to `string[]` at the config boundary.
        entryPoints: [...draft.entryPoints] as string[],
        selectedContributors: [...draft.selectedContributors] as string[],
        extends: [...(draft.extends ?? [])],
      };

      const newId = crypto.randomUUID();
      let next: CompositionManifestItem[];
      if (editingId !== undefined) {
        // Spreading the existing item first preserves its `category` (engine-opaque
        // metadata the draft doesn't carry); `fields` overwrites the rest.
        next = items.map((item) =>
          item.id === editingId ? { ...item, ...fields } : item,
        );
      } else {
        // Appended at the end — array position is the order (no rank).
        const newItem: CompositionManifestItem = {
          id: newId,
          // New drafts default to the `app` category; re-categorise via config edit.
          category: "app",
          // `excludes` (the self-containment guard) isn't part of the editable
          // draft yet — seed it empty; set it via config edit. The edit path above
          // preserves any existing `excludes` through the `...item` spread.
          excludes: [] as string[],
          // New drafts are not served; pick a mode via the Studio control.
          serve: "off",
          // No home until one is picked in Studio — `composition-closure` refuses
          // a bundle with apps but no home, so the gap is loud, not load order.
          home: "",
          ...fields,
        };
        next = [...items, newItem];
      }

      setConfig("manifests", next);
      return editingId ?? newId;
    },
    [items, setConfig],
  );

  const remove = useCallback(
    (id: string) => {
      // Keyed on which config layer owns the row, not on servability: the
      // reason these two cannot go is "the manifest must carry exactly one of
      // each, and only the committed config can put one back" — the same fact
      // that makes `save` refuse them.
      if (isCommittedSourceComposition(id)) {
        throw new Error(
          `Cannot delete the "${id}" composition — the manifest must carry exactly one such entry, ` +
            `and only plugins/plugin-meta/plugins/composition/core/config.ts can put it back.`,
        );
      }
      setConfig(
        "manifests",
        items.filter((item) => item.id !== id),
      );
    },
    [items, setConfig],
  );

  const setServeMode = useCallback(
    (id: string, mode: string) => {
      // Keyed on servability, not on main's id: the reason the mode is
      // meaningless is "no serve build will ever provision this namespace",
      // which is exactly what this predicate answers — and it is the same
      // predicate the inert controls and `activatedCompositionIds` read.
      if (!isServableCompositionId(id)) {
        throw new Error(
          `Cannot set the serve mode on "${id}" — it is never served as a composition, so the mode has no effect.`,
        );
      }
      setConfig(
        "manifests",
        items.map((item) => (item.id === id ? { ...item, serve: mode } : item)),
      );
    },
    [items, setConfig],
  );

  const setHome = useCallback(
    (id: string, home: string) => {
      if (isCommittedSourceComposition(id)) {
        throw new Error(
          `Cannot set the home of the "${id}" composition at runtime — codegen reads the committed config, ` +
            `so a stored edit would be silently inert. Edit plugins/plugin-meta/plugins/composition/core/config.ts and rebuild.`,
        );
      }
      setConfig(
        "manifests",
        items.map((item) => (item.id === id ? { ...item, home } : item)),
      );
    },
    [items, setConfig],
  );

  return { save, remove, setServeMode, setHome };
}
