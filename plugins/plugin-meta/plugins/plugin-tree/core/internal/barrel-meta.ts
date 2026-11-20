import {
  parseStringField,
  parseBoolField,
  defaultExportObjectBody,
} from "@plugins/plugin-meta/plugins/parse-utils/core";

// Metadata read directly from a plugin barrel's OWN `export default { … }` object
// literal. Reading the original source (never transpiler output) is the root-cause
// fix: Bun's transpiler re-quotes string literals, so recovering a description from
// stripped output silently dropped any description containing an escaped quote.
export interface BarrelMeta {
  description?: string;
  loadBearing: boolean;
  collapsed: boolean;
  expanded: boolean;
}

/**
 * Parse a plugin barrel's own `export default { … } satisfies PluginDefinition`
 * body and read its top-level `description` / `loadBearing` / `collapsed` / `expanded` fields.
 *
 * Throws when the barrel has no default-exported object literal (a loader
 * invariant, new — cannot fire on today's tree) or when `description` is present
 * but not a static string literal (the docs pipeline reads it textually, so a
 * dynamic value would be silently lost — fail loudly instead).
 */
export function parsePluginBarrel(src: string, file: string): BarrelMeta {
  const obj = defaultExportObjectBody(src);
  if (obj.kind === "absent") {
    throw new Error(
      `${file}: no \`export default { … }\` object literal. Every plugin barrel must default-export an object literal (\`export default { … } satisfies PluginDefinition\`); the plugin loader requires one.`,
    );
  }
  const body = obj.body;

  // Top-level-only scoping (`depth0`) so a nested contribution object carrying its
  // own `description:` / `loadBearing:` can never shadow or leak into the barrel's.
  const desc = parseStringField(body, "description", { depth0: true });
  let description: string | undefined;
  switch (desc.kind) {
    case "value":
      description = desc.value;
      break;
    case "absent":
      description = undefined;
      break;
    case "dynamic":
      throw new Error(
        `${file}: \`description\` is not a static string literal (got \`${desc.expr}\`). The docs pipeline reads this field textually — inline a literal string.`,
      );
  }

  return {
    description,
    loadBearing: parseBoolField(body, "loadBearing", { depth0: true }),
    collapsed: parseBoolField(body, "collapsed", { depth0: true }),
    expanded: parseBoolField(body, "expanded", { depth0: true }),
  };
}
