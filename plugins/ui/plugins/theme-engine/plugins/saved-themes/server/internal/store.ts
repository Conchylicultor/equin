import { asc, eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { setConfig } from "@plugins/config_v2/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import {
  DEFAULT_THEME_ID,
  themeSelectionConfig,
} from "@plugins/ui/plugins/theme-engine/core";
import {
  applyFragmentEdit,
  importedThemeId,
  type FragmentEdit,
  type SavedTheme,
  type SaveThemeInput,
  type ThemeScopeRef,
} from "../../core";
import type { ColorAdjustment } from "@plugins/ui/plugins/theme-engine/core";
import { _savedThemes } from "./tables";
import { checkExtendsTarget } from "./extends-target";
import { foldParentInto } from "./fold-parent";
import { planDelete } from "./delete-plan";
import { readThemeSelections } from "./theme-selections";

type Row = typeof _savedThemes.$inferSelect;

function toSavedTheme(row: Row): SavedTheme {
  return {
    id: row.id,
    label: row.label,
    source: row.source,
    fragments: row.fragments,
    ...(row.extends === null ? {} : { extends: row.extends }),
    ...(row.colorAdjust === null ? {} : { colorAdjust: row.colorAdjust }),
  };
}

function idFor(input: SaveThemeInput): string {
  return input.source === "tweakcn"
    ? importedThemeId(input.source, input.externalId)
    : `custom:${crypto.randomUUID()}`;
}

const changeListeners = new Set<() => void>();

/**
 * Hear every committed change to the saved themes (a save, an edit, a rename, a
 * delete) — every write goes through this module, so it is the one place that
 * knows. Returns the unsubscribe.
 */
export function onSavedThemesChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyChanged(): void {
  for (const listener of [...changeListeners]) listener();
}

export async function listSavedThemes(): Promise<SavedTheme[]> {
  const rows = await db
    .select()
    .from(_savedThemes)
    .orderBy(asc(_savedThemes.createdAt), asc(_savedThemes.id));
  return rows.map(toSavedTheme);
}

/**
 * Save a theme — the one write path for both the create endpoint and an
 * importer (tweakcn) calling in-process. Refuses (422) an `extends` the chain
 * rules reject, so the resolver's missing-target / cycle throw stays
 * unreachable for anything written here.
 */
export async function saveTheme(input: SaveThemeInput): Promise<SavedTheme> {
  const id = idFor(input);
  const saved = await db.transaction(async (tx) => {
    if (input.extends !== undefined) {
      const parents = await tx
        .select({ id: _savedThemes.id, extends: _savedThemes.extends })
        .from(_savedThemes);
      const check = checkExtendsTarget(
        id,
        input.extends,
        new Map(parents.map((p) => [p.id, p.extends ?? undefined])),
      );
      if (!check.ok) throw new HttpError(422, check.reason);
    }

    const fields = {
      label: input.label,
      extends: input.extends ?? null,
      fragments: input.fragments,
      colorAdjust: input.colorAdjust ?? null,
    };
    const [row] = await tx
      .insert(_savedThemes)
      .values({
        id,
        source: input.source,
        externalId: input.source === "tweakcn" ? input.externalId : null,
        ...fields,
      })
      .onConflictDoUpdate({
        target: _savedThemes.externalId,
        targetWhere: sql`external_id IS NOT NULL`,
        set: fields,
      })
      .returning();
    if (!row) throw new Error(`[saved-themes] saving "${id}" returned no row`);
    return toSavedTheme(row);
  });
  notifyChanged();
  return saved;
}

/**
 * Change one custom theme under a row lock. Code and tweakcn themes are
 * read-only: an edit to one lands on a custom copy (see `useEditTheme`), so a
 * write reaching a non-custom row here is refused.
 */
async function updateCustomTheme(
  id: string,
  change: (
    theme: SavedTheme,
  ) => Partial<Pick<Row, "label" | "fragments" | "colorAdjust">>,
): Promise<SavedTheme> {
  const theme = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(_savedThemes)
      .where(eq(_savedThemes.id, id))
      .for("update");
    if (!row) throw new HttpError(404, `No saved theme "${id}"`);
    if (row.source !== "custom") {
      throw new HttpError(
        409,
        `"${row.label}" is a ${row.source} theme, which is read-only — edit a custom copy instead`,
      );
    }
    const [updated] = await tx
      .update(_savedThemes)
      .set(change(toSavedTheme(row)))
      .where(eq(_savedThemes.id, id))
      .returning();
    if (!updated)
      throw new Error(`[saved-themes] updating "${id}" returned no row`);
    return toSavedTheme(updated);
  });
  notifyChanged();
  return theme;
}

export function editThemeFragment(
  id: string,
  edit: FragmentEdit,
): Promise<SavedTheme> {
  return updateCustomTheme(id, (theme) => ({
    fragments: applyFragmentEdit(theme.fragments, edit),
  }));
}

export function setThemeColorAdjust(
  id: string,
  colorAdjust: ColorAdjustment | null,
): Promise<SavedTheme> {
  return updateCustomTheme(id, () => ({ colorAdjust }));
}

export function renameTheme(id: string, label: string): Promise<SavedTheme> {
  return updateCustomTheme(id, () => ({ label }));
}

/**
 * Delete a saved theme. Refused (409, `SavedThemeInUse` body) while a scope
 * still selects it, unless `reassign` — then those scopes move to Default
 * first. Themes extending it have its values folded in (`foldParentInto`), so
 * no row is ever left extending a theme that is gone.
 */
export async function deleteTheme(
  id: string,
  opts: { reassign: boolean; writer: WriteOrigin },
): Promise<{ reassigned: ThemeScopeRef[] }> {
  const [row] = await db
    .select()
    .from(_savedThemes)
    .where(eq(_savedThemes.id, id));
  if (!row) throw new HttpError(404, `No saved theme "${id}"`);

  const plan = planDelete(row, readThemeSelections(), opts.reassign);
  if (plan.kind === "refuse") {
    // HttpError carries text; fetchEndpoint upgrades a JSON error body to an
    // object, so the caller reads `usedBy` off `EndpointError.body` (parse it
    // with `SavedThemeInUseSchema`) and the global toast shows `message`.
    throw new HttpError(409, JSON.stringify(plan.inUse));
  }

  for (const scope of plan.reassign) {
    await setConfig(themeSelectionConfig, "theme", DEFAULT_THEME_ID, {
      writer: opts.writer,
      ...(scope.scopeId === undefined ? {} : { scopeId: scope.scopeId }),
    });
  }

  await db.transaction(async (tx) => {
    const [parent] = await tx
      .select()
      .from(_savedThemes)
      .where(eq(_savedThemes.id, id))
      .for("update");
    if (!parent) throw new HttpError(404, `No saved theme "${id}"`);
    const children = await tx
      .select()
      .from(_savedThemes)
      .where(eq(_savedThemes.extends, id))
      .for("update");
    for (const child of children) {
      const folded = foldParentInto(toSavedTheme(parent), toSavedTheme(child));
      await tx
        .update(_savedThemes)
        .set({
          extends: folded.extends ?? null,
          fragments: folded.fragments,
          colorAdjust: folded.colorAdjust ?? null,
        })
        .where(eq(_savedThemes.id, child.id));
    }
    await tx.delete(_savedThemes).where(eq(_savedThemes.id, id));
  });
  notifyChanged();

  return { reassigned: plan.reassign };
}
