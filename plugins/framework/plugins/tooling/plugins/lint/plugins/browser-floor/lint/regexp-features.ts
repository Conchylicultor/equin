/**
 * What a regular expression needs of the browser: its flags (each a `RegExp`
 * member in the compat data — `v` is `unicodeSets`) and the syntax its pattern
 * uses (keys under `javascript.regular_expressions`), parsed with regexpp, the
 * parser ESLint's own regex rules use.
 *
 * A regex above the floor fails where it is CREATED, not where it is used: a
 * literal with a flag the engine lacks is a parse error of the whole module,
 * and the build lowers such a literal to `new RegExp(…)`, which throws at
 * module evaluation ("Invalid flags supplied to RegExp constructor") — either
 * way every importer of the module fails to load (equin.ai's page editor did,
 * 2026-11-19, on emoji's `\p{RGI_Emoji}` with `v`).
 */
import {
  RegExpParser,
  RegExpSyntaxError,
  visitRegExpAST,
} from "@eslint-community/regexpp";

/** Each flag, as the `RegExp` member the compat data files it under. */
export const FLAG_MEMBER: Readonly<Record<string, string>> = {
  d: "hasIndices",
  g: "global",
  i: "ignoreCase",
  m: "multiline",
  s: "dotAll",
  u: "unicode",
  v: "unicodeSets",
  y: "sticky",
};

export type RegexpFeatures =
  | {
      ok: true;
      /** The flags' `RegExp` members (`unicodeSets`). */
      flagMembers: string[];
      /** Unknown flag characters: an error in every engine. */
      unknownFlags: string[];
      /** The pattern's syntax, by compat-data key (`lookbehind_assertion`). */
      syntax: Set<string>;
    }
  | { ok: false; error: string };

const parser = new RegExpParser({ ecmaVersion: 2025 });

/** The flags and syntax a regex with this source and flags uses. */
export function regexpFeatures(pattern: string, flags: string): RegexpFeatures {
  const flagMembers: string[] = [];
  const unknownFlags: string[] = [];
  for (const f of flags) {
    const member = FLAG_MEMBER[f];
    if (member === undefined) unknownFlags.push(f);
    else flagMembers.push(member);
  }
  const syntax = new Set<string>();
  let ast;
  try {
    ast = parser.parsePattern(pattern, 0, pattern.length, {
      unicode: flags.includes("u"),
      unicodeSets: flags.includes("v"),
    });
  } catch (err) {
    if (err instanceof RegExpSyntaxError)
      return { ok: false, error: err.message };
    throw err;
  }
  const groupNames = new Set<string>();
  visitRegExpAST(ast, {
    onGroupEnter(node) {
      if (node.modifiers !== null) syntax.add("modifier");
    },
    onAssertionEnter(node) {
      if (node.kind === "lookbehind") syntax.add("lookbehind_assertion");
    },
    onCapturingGroupEnter(node) {
      if (node.name === null) return;
      syntax.add("named_capturing_group");
      if (groupNames.has(node.name))
        syntax.add("named_capturing_group.duplicate_named_capturing_groups");
      groupNames.add(node.name);
    },
    onBackreferenceEnter(node) {
      if (typeof node.ref === "string") syntax.add("named_backreference");
    },
    onCharacterSetEnter(node) {
      if (node.kind === "property")
        syntax.add("unicode_character_class_escape");
    },
    onCharacterEnter(node) {
      if (node.raw.startsWith("\\u{")) syntax.add("character_escape.unicode");
    },
  });
  return { ok: true, flagMembers, unknownFlags, syntax };
}
