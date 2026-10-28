import { z } from "zod";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import symbolNameList from "./symbol-names.json";

let names: ReadonlySet<string> | null = null;

function symbolNames(): ReadonlySet<string> {
  names ??= new Set(symbolNameList.names.split(" "));
  return names;
}

/** Whether `name` is a Material Symbols base name the installed sets draw (any style). */
export function isSavedSymbolName(name: string): name is SavedSymbolName {
  return symbolNames().has(name);
}

/**
 * THE parse that mints a {@link SavedSymbolName}: a string that is a base name
 * of the installed Material Symbols sets (the same `SymbolName` list the
 * sprites build from). Every store of a user-picked icon decodes through it —
 * request bodies, the DB column, config, page block data — so an unknown or
 * classic (`add_circle_outline`) name cannot be stored or read back.
 */
export const SavedSymbolNameSchema: z.ZodType<SavedSymbolName> = z
  .string()
  .refine(isSavedSymbolName, {
    error: (iss) => `"${String(iss.input)}" is not a Material Symbols name`,
  })
  .transform((name) => name as SavedSymbolName);

/** {@link SavedSymbolNameSchema} as a throwing call, for a name read from somewhere with no schema. */
export function parseSavedSymbolName(name: string): SavedSymbolName {
  return SavedSymbolNameSchema.parse(name);
}

/** Every saved symbol name, sorted — the whole set a runtime symbol can be drawn from. */
export function allSavedSymbolNames(): readonly SavedSymbolName[] {
  return [...symbolNames()] as SavedSymbolName[];
}
