import type {
  TokenGroupDescriptor,
  TokenGroupFragment,
} from "@plugins/ui/plugins/theme-engine/core";
import type { TokenGroupEditor } from "../internal/use-token-group-editor";
import { TokenRow } from "./token-row";

/** A token group editor whose theme is known — the only kind a row can edit. */
export type ReadyTokenGroupEditor = Extract<
  TokenGroupEditor,
  { pending: false }
>;

/**
 * One editable row per token in `keys`, showing the value the scope paints in
 * the editor's mode and writing through the editor. Reset appears only on a
 * token the scope's own custom theme sets — clearing it shows the inherited
 * value again.
 */
export function TokenRows({
  editor,
  group,
  keys,
  search,
}: {
  editor: ReadyTokenGroupEditor;
  group: TokenGroupDescriptor;
  keys: readonly string[];
  search: string;
}) {
  const shown =
    editor.mode === "dark" ? editor.values.dark : editor.values.light;
  return (
    <>
      {keys.map((key) => (
        <TokenRow
          key={key}
          label={group.schema[key]?.label ?? key}
          cssVar={group.vars[key] ?? `--${key}`}
          value={shown[key] ?? ""}
          options={group.schema[key]?.values}
          isOverridden={isOverridden(editor, key)}
          isSplit={isSplit(editor.own, key)}
          search={search}
          onValueChange={(value) => editor.setToken(key, value)}
          onReset={() => editor.resetToken(key)}
        />
      ))}
    </>
  );
}

// Whether Reset has anything to clear in the editor's mode ("both" = either).
function isOverridden(editor: ReadyTokenGroupEditor, key: string): boolean {
  const own = editor.own;
  if (!own) return false;
  const inLight = own.light[key] !== undefined;
  const inDark = own.dark[key] !== undefined;
  if (editor.mode === "light") return inLight;
  if (editor.mode === "dark") return inDark;
  return inLight || inDark;
}

// The scope's own edit gives light and dark different values (or sets only one).
function isSplit(own: TokenGroupFragment | undefined, key: string): boolean {
  if (!own) return false;
  const light = own.light[key];
  const dark = own.dark[key];
  return (light !== undefined || dark !== undefined) && light !== dark;
}
