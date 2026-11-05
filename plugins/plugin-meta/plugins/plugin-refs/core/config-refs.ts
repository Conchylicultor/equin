import {
  findNodeAtLocation,
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { parseEntryPattern } from "@plugins/plugin-meta/plugins/closure/plugins/entry-pattern/core";
import { assertRange, lineIndex } from "./resolve";
import type { DotRef } from "./types";

function parseJsonc(file: string, text: string): JsonNode {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (!tree || errors.length > 0) {
    const e = errors[0];
    throw new Error(
      `plugin-refs: ${file} is not valid JSONC${e ? ` (${printParseErrorCode(e.error)} at offset ${e.offset})` : ""}`,
    );
  }
  return tree;
}

/** Offset of a string node's first character inside its quotes. */
const stringStart = (node: JsonNode) => node.offset + 1;

/** The manifest fields whose entries are plugin ids (entry patterns). `extends`
 *  and `excludes` hold COMPOSITION names, not plugin ids, and are not refs. */
const MANIFEST_ID_FIELDS = ["entryPoints", "selectedContributors"] as const;

/**
 * Every plugin id in the compositions manifest's `entryPoints` /
 * `selectedContributors`, read through the closure engine's own
 * `parseEntryPattern`. The range spans the base id, so `!` and `.**` survive a
 * rewrite. The root pattern `**` names no plugin and is skipped.
 */
export function scanCompositionManifestRefs(
  file: string,
  text: string,
): DotRef[] {
  const tree = parseJsonc(file, text);
  const manifests = findNodeAtLocation(tree, ["manifests"]);
  if (manifests?.type !== "array" || !manifests.children) {
    throw new Error(`plugin-refs: ${file} has no "manifests" array`);
  }
  const lineOf = lineIndex(text);
  const out: DotRef[] = [];
  for (const manifest of manifests.children) {
    for (const field of MANIFEST_ID_FIELDS) {
      const list = findNodeAtLocation(manifest, [field]);
      if (!list) continue;
      if (list.type !== "array") {
        throw new Error(`plugin-refs: ${file}: "${field}" is not an array`);
      }
      for (const el of list.children ?? []) {
        if (el.type !== "string") {
          throw new Error(
            `plugin-refs: ${file}: a "${field}" entry is not a string`,
          );
        }
        const parsed = parseEntryPattern(el.value as string);
        if (parsed.kind === "root") continue;
        const start = stringStart(el) + (parsed.negate ? 1 : 0);
        const range = { start, end: start + parsed.base.length };
        assertRange(file, text, range, parsed.base);
        out.push({
          kind: "dot",
          site: "composition-manifest",
          file,
          range,
          line: lineOf(start),
          value: parsed.base,
          id: parsed.base,
        });
      }
    }
  }
  return out;
}

// `${pluginId}:${id}` reorder entryKey; pluginId is the dot-id before the colon.
const ENTRY_KEY_RE = /^[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.-]*$/i;

/** Every string element of any `items` array, at any depth (reorder overrides
 *  nest groups whose own `items` hold entry keys too). */
function collectItemStrings(node: JsonNode, acc: JsonNode[]): void {
  if (node.type === "property") {
    const [key, value] = node.children ?? [];
    if (key?.value === "items" && value?.type === "array") {
      for (const el of value.children ?? []) {
        if (el.type === "string") acc.push(el);
        else collectItemStrings(el, acc);
      }
      return;
    }
    if (value) collectItemStrings(value, acc);
    return;
  }
  for (const child of node.children ?? []) collectItemStrings(child, acc);
}

/**
 * The plugin-id half of every reorder override entry key
 * (`"<pluginId>:<contribution id>"`) found in an `items` array of a config
 * JSONC file.
 */
export function scanReorderItemRefs(file: string, text: string): DotRef[] {
  if (!text.includes('"items"')) return [];
  const nodes: JsonNode[] = [];
  collectItemStrings(parseJsonc(file, text), nodes);
  const lineOf = lineIndex(text);
  const out: DotRef[] = [];
  for (const node of nodes) {
    const key = node.value as string;
    if (!ENTRY_KEY_RE.test(key)) continue;
    const id = key.slice(0, key.indexOf(":"));
    const start = stringStart(node);
    const range = { start, end: start + id.length };
    assertRange(file, text, range, id);
    out.push({
      kind: "dot",
      site: "reorder-items",
      file,
      range,
      line: lineOf(start),
      value: id,
      id: asPluginId(id),
    });
  }
  return out;
}
