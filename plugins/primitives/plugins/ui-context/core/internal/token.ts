import { z } from "zod";

export interface UiContextMeta {
  url: string;
  pluginId?: string;
  slotId?: string;
  // Author-supplied contribution id, keyed for cross-plugin uniqueness as
  // `pluginId:id` (e.g. "improve/element-picker:element-picker").
  contributionId?: string;
  // Composition lineage outer→inner, e.g. "apps/deploy/deployments#pane:deploy-
  // deployment-detail[column 3 of 3] > tasks/task-header@TaskDetail.Section".
  // `@` means "contributes into", `#` means "occupies". Points at the
  // contributing source far more precisely than pluginId alone, and is the SOLE
  // carrier of region information (which pane / tab / window) — there is
  // deliberately no separate `region`/`pane` field to drift from it.
  path?: string;
  // The slots whose contributions sit INSIDE the picked element — its
  // outermost layer only, distinct, in document order, joined by ", ". `path`
  // looks up from the pick; this looks down. It is what places a pick on a
  // bare container (a bar, a wrapper, the slack between widgets) that lies in
  // no slot itself: "the div holding the prompt bar" instead of just "div".
  innerSlots?: string;
  element: string; // e.g. "button — Improve this app"
  selector?: string; // short CSS path for precision, e.g. "header>div>button"
  // Repo-relative source `file:line` of the picked element, stamped by the
  // source-location build transform (present only when that transform is active).
  source?: string;
  // The nearest *semantic* component that owns the picked element, as
  // `Name@file:line` (e.g. "LaunchControl@plugins/.../launch-control.tsx:197").
  // Stamped by injecting `data-ui-owner` on component callsites, which rides the
  // composed primitive's `{...props}` spread onto the host element — so it names
  // the composing component (which authors no host element of its own) rather
  // than the leaf primitive `source` points at. Complements `source`; omitted
  // when the picked element doesn't flow through a prop-forwarding primitive.
  owner?: string;
}

// One machine-coordinate field of the ui-context tag. THE single source of truth
// for the attribute set: serialize writes these, parse reads these, and the chip
// popover displays these — each by iterating this list. Adding a field here makes
// it flow to the wire, the parser, and the UI by construction, so the three can
// never drift out of sync (the bug where the popover silently dropped
// contribution/source/owner). `element` is intentionally absent — it is the
// <picked-content> body, not an attribute, and is handled on its own.
export interface UiContextField {
  /** Property on UiContextMeta this field reads/writes. */
  key: Exclude<keyof UiContextMeta, "element">;
  /** Attribute name in the serialized `<ui-context …>` tag. */
  attr: string;
  /** Human-readable label shown in the chip popover. */
  label: string;
  /** Always emitted (never omitted-when-empty). Only `url` is required. */
  required?: boolean;
}

// Preserves the literal `key` of each field (so the exhaustiveness check below
// can see exactly which keys are registered) while typing the rest as a full
// UiContextField — so `.required` is always present, not narrowed away.
const field = <K extends UiContextField["key"]>(
  key: K,
  attr: string,
  label: string,
  required = false,
): UiContextField & { key: K } => ({ key, attr, label, required });

// Ordered once; this order is the serialized attribute order AND the popover row
// order. `url` leads (matching the historical wire format), the rest follow
// outer→inner / coarse→fine.
//
// There is no `pane` field: the containing pane is a region node inside `path`,
// which would make a scalar `pane=` redundant with it (and ambiguous — a pane id
// names a definition, not a position). Tags serialized before that change carry
// `pane="…"`; no legacy branch is needed, because parsing is driven by this list
// and simply ignores unregistered attributes.
export const UI_CONTEXT_FIELDS = [
  field("url", "url", "URL", true),
  field("pluginId", "plugin", "Plugin"),
  field("slotId", "slot", "Slot"),
  field("contributionId", "contribution", "Contribution"),
  field("path", "path", "Path"),
  field("innerSlots", "inner-slots", "Inner slots"),
  field("selector", "selector", "Selector"),
  field("source", "source", "Source"),
  field("owner", "owner", "Owner"),
];

// Compile-time exhaustiveness: every attribute key of UiContextMeta MUST appear
// in UI_CONTEXT_FIELDS. Add a field to the interface without registering it and
// this line fails to type-check, naming the missing key — so a new field cannot
// be serialized/parsed/displayed inconsistently, it simply won't compile.
type RegisteredKey = (typeof UI_CONTEXT_FIELDS)[number]["key"];
type UnregisteredKey = Exclude<Exclude<keyof UiContextMeta, "element">, RegisteredKey>;
const _allFieldsRegistered: UnregisteredKey extends never ? true : UnregisteredKey =
  true;
void _allFieldsRegistered;

// The wire schema, for producers that cross a trust boundary (a crash payload
// POSTed from the browser and persisted as jsonb). Only `url` and `element` are
// required, matching the interface — and `element` must stay required here, or
// the mutual-assignability check below stops compiling.
export const UiContextMetaSchema = z.object({
  url: z.string(),
  pluginId: z.string().optional(),
  slotId: z.string().optional(),
  contributionId: z.string().optional(),
  path: z.string().optional(),
  innerSlots: z.string().optional(),
  element: z.string(),
  selector: z.string().optional(),
  source: z.string().optional(),
  owner: z.string().optional(),
});

// Compile-time binding of the schema to the interface, the same trick
// `_allFieldsRegistered` uses above — in two parts, because neither half alone
// is sufficient.
//
// KEY SETS first. Mutual assignability is blind to an OMITTED OPTIONAL field:
// drop `owner` from the schema and `{…no owner}` is still assignable to
// UiContextMeta (`owner?` may be absent) *and* UiContextMeta is still assignable
// back (an extra optional property is fine) — the check passes while the wire
// schema silently strips the field on ingest. Comparing `keyof` both ways closes
// that, and names the offending key in the error.
type _UnschemaedKey = Exclude<
  keyof UiContextMeta,
  keyof z.infer<typeof UiContextMetaSchema>
>;
type _UnknownSchemaKey = Exclude<
  keyof z.infer<typeof UiContextMetaSchema>,
  keyof UiContextMeta
>;
const _everyFieldInSchema: _UnschemaedKey extends never ? true : _UnschemaedKey =
  true;
const _noExtraSchemaField: _UnknownSchemaKey extends never
  ? true
  : _UnknownSchemaKey = true;
void _everyFieldInSchema;
void _noExtraSchemaField;

// THEN the shapes, for the drift key sets can't see: a field whose optionality
// or type diverges (schema makes `url` optional, or types `path` as a number).
type _SchemaMatches =
  z.infer<typeof UiContextMetaSchema> extends UiContextMeta
    ? UiContextMeta extends z.infer<typeof UiContextMetaSchema>
      ? true
      : never
    : never;
const _schemaMatchesType: _SchemaMatches = true;
void _schemaMatchesType;

// Attribute values are quote-delimited, so only `"` would break them (a `>`
// inside quotes — e.g. a CSS selector "div>div" — is fine). Collapse whitespace
// so the tag stays single-line for the editor's line-based markdown sync.
const sanitizeAttr = (v: string) =>
  v.replace(/"/g, "'").replace(/\s+/g, " ").trim();

// The body is angle-bracket-delimited and captured as `[^<]*`, so a stray `<`
// would terminate it early; strip it (a `>` is harmless in the body).
const sanitizeBody = (v: string) =>
  v.replace(/</g, "'").replace(/\s+/g, " ").trim();

// Fixed, model-facing hint carried in its own body tag. The tag flows verbatim
// into the agent prompt, so an agent reading it cold needs to know what it is
// and how the user produced it. It's framing — *not* picked data — so it lives
// in a distinct <hint> tag, kept apart from the <picked-content> label rather
// than concatenated into one flat run the model has to disentangle.
const HINT =
  "The user pointed at this element in the live app using the element-picker inspector; it is the UI element their request refers to.";

/** Why this token is being emitted — the one thing that differs between
 *  producers. The eight attributes are already fully generic; only the body's
 *  framing is producer-specific, and it would actively lie if reused (a crash
 *  report is not something "the user pointed at"). */
export type UiContextProvenance = "picked" | "crash";

// Closed set: both runtimes need it and it is enumerable today, so it is plain
// data in core/ rather than a slot (per the collection-vs-closed-list rule).
// Deliberately NOT a UI_CONTEXT_FIELDS attribute: provenance says why we are
// emitting, not where the element is — and a non-`string` union in UiContextMeta
// would break both the `Exclude<keyof UiContextMeta, "element">` exhaustiveness
// check and `parseUiContext`'s `meta[f.key] = v` string assignment.
const PROVENANCE = {
  picked: {
    bodyTag: "picked-content",
    hint: HINT,
  },
  crash: {
    bodyTag: "crash-site",
    hint: "A React error boundary caught a crash here. The path names the plugin, slot and screen region the throwing subtree occupied; the throwing component itself is named by the component stack.",
  },
} as const satisfies Record<
  UiContextProvenance,
  { bodyTag: string; hint: string }
>;

// Legacy flat-body preamble (hint + label concatenated). Retained only so the
// parser still reads tags serialized before the <hint>/<picked-content> split.
const LEGACY_BODY_PREAMBLE = `${HINT} Picked element: `;

// Structured machine coordinates live in attributes; the constant hint and the
// per-emission label live in the body as two sibling tags — the standard XML
// split, which reads far more naturally to a model than cramming prose into an
// attribute, and keeps the fixed framing cleanly separated from the content.
//
// `provenance` is REQUIRED, not defaulted: a default would let a future producer
// silently ship the picker's hint on a token that has nothing to do with a pick.
export function serializeUiContext(
  m: UiContextMeta,
  provenance: UiContextProvenance,
): string {
  const { bodyTag, hint } = PROVENANCE[provenance];
  const attrs = UI_CONTEXT_FIELDS.map((f) => {
    const v = m[f.key] ?? "";
    return f.required || v ? ` ${f.attr}="${sanitizeAttr(v)}"` : "";
  }).join("");
  return `<ui-context${attrs}><hint>${hint}</hint><${bodyTag}>${sanitizeBody(m.element)}</${bodyTag}></ui-context>`;
}

// Match the paired tag. Attribute values are quoted so they may safely contain
// `>` (e.g. a CSS-path selector "div>div>div"); the body nests a <hint> and one
// provenance body tag, so it's matched non-greedily up to the closing tag —
// which is why a new provenance needs no change here. Those nested tags are the
// only `<` the body holds — the label is `<`-sanitized at serialize time. Stays
// single-line so it survives the editor's line-based scan.
export const UI_CONTEXT_RE =
  /<ui-context(?:\s+[\w-]+="[^"]*")*\s*>[\s\S]*?<\/ui-context>/g;

// Built from PROVENANCE so registering a provenance teaches the parser its body
// tag — the alternation is never spelled out a second time. The backreference
// (`</\1>`) means an open tag can only close with its own name, so a malformed
// `<picked-content>…</crash-site>` is not silently accepted.
const BODY_RE = new RegExp(
  `<(${Object.values(PROVENANCE)
    .map((p) => p.bodyTag)
    .join("|")})>([\\s\\S]*?)</\\1>`,
);

// Accepts the raw matched `<ui-context …>` substring (e.g. an active-data inline
// contribution's `content`, or a `UI_CONTEXT_RE` match's [0]).
export function parseUiContext(tag: string): UiContextMeta | null {
  const get = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(tag)?.[1];
  const url = get("url");
  // New tags carry the label in their provenance's body tag; fall back to the
  // legacy flat body (hint + label concatenated) so tags from before the
  // <hint>/<picked-content> split still parse.
  let element = BODY_RE.exec(tag)?.[2]?.trim();
  if (element === undefined) {
    const body = tag
      .replace(/^<ui-context[^>]*>/, "")
      .replace(/<\/ui-context>$/, "")
      .trim();
    element = body.startsWith(LEGACY_BODY_PREAMBLE)
      ? body.slice(LEGACY_BODY_PREAMBLE.length).trim()
      : body;
  }
  if (!url || !element) return null;
  const meta: UiContextMeta = { url, element };
  for (const f of UI_CONTEXT_FIELDS) {
    if (f.key === "url") continue; // captured above and validated non-empty
    const v = get(f.attr);
    if (v !== undefined) meta[f.key] = v;
  }
  return meta;
}
