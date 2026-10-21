import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseJsonc } from "jsonc-parser";
import {
  APP_SCOPE_DIR,
  CONFIG_HASH_RE,
  REVIEW_MARKER,
  configFileOwner,
  hasReviewMarker,
  withOverrideLegend,
} from "@plugins/config_v2/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import {
  loadConfigDescriptorsByOriginPath,
  walkJsoncFiles,
} from "./config-origin-gen";
import { writeGenerated } from "./write-generated";

/**
 * Build-time seeding of the **mandatory** committed overrides — the files a
 * descriptor declares it owes via `requiresAuthoredOverride`.
 *
 * The obligation splits into a mechanical half (produce the file at the right
 * path, copy the materialized catalog, transcribe the `// @hash`) and a judgment
 * half (arrange the values for how the surface actually renders). Only the build
 * *can* do the mechanical half — the origin's defaults come from a barrel-importing
 * tree walk, so its hash is un-hand-computable — and only a human can do the
 * judgment half. This module does the mechanical half and marks the result
 * `@review`, which is the judgment half's one gate: deleting that line is the
 * claim that the values below are deliberate.
 *
 * Two events route through that single gate:
 *   - **seed** — the override is missing AND the descriptor says its default is
 *     worth authoring (`seedWhen`) → write the origin's bytes verbatim (same
 *     hash, same body, same legend comments) plus the marker block.
 *   - **re-mark + re-stamp** — an existing override's `@hash` went stale (a
 *     contribution appeared/disappeared under it) → restamp the header to the
 *     current hash AND insert the marker, body bytes untouched.
 *
 * Re-stamping a hash normally means silencing a staleness gate; here it is only
 * ever issued together with a marker that opens a louder one, so the net effect
 * is strictly stronger than the status quo — "retype this hash to acknowledge"
 * (a transcription) becomes "these values are deliberate" (a review). It is also
 * build-only and a marker can never land: `regen-generated` refuses a tree that
 * carries one.
 *
 * Family-agnostic by construction: every word of instruction written into a
 * seeded file comes from the descriptor's own `guidance`. Adding a third family
 * that owes an authored override costs zero edits here.
 */

export interface AuthoredOverrideSeedResult {
  /** Overrides created from scratch (relative to `config/`). */
  seeded: string[];
  /** Existing overrides re-stamped + re-marked (relative to `config/`). */
  remarked: string[];
}

/**
 * `// @hash <hash>` + the descriptor's `// @legend` block + the marker block +
 * the body. The legend goes through the same `withOverrideLegend` the per-build
 * stamp uses, so a file this pass writes is already in its final shape — no
 * second build needed to settle it.
 */
function renderHeaderedFile(
  hash: string,
  descriptor: ConfigDescriptor,
  markerLines: string[],
  body: string,
): string {
  return withOverrideLegend(
    `// @hash ${hash}\n` + markerLines.map((l) => `${l}\n`).join("") + body,
    descriptor.overrideLegend ?? [],
  );
}

function seedMarkerLines(descriptor: ConfigDescriptor): string[] {
  const guidance = descriptor.requiresAuthoredOverride?.guidance ?? [];
  return [
    `${REVIEW_MARKER} — seeded, not authored. Delete this line once the values below are deliberate.`,
    ...guidance.map((g) => `// ${g}`),
  ];
}

/**
 * Is this origin's default worth authoring at all? — the descriptor's own
 * `seedWhen` answer, asked once, only on the path that would CREATE a file.
 *
 * A default can be vacuous: a render slot with no contributions has no
 * arrangement to make, so seeding `{"items": []}` would mint a review request
 * whose only honest resolution is a rubber stamp — and a hundred of those bury
 * the one file where a decision is genuinely pending. The engine stays
 * descriptor-agnostic: it never inspects the document itself, it asks.
 *
 * Deliberately NOT consulted on the re-mark path. That path rewrites a file a
 * human already authored; suppressing its marker there would silently restamp a
 * stale hash (see `remarkIfStale`), and "your slot just lost every contribution"
 * is a change worth telling its author about even though nothing is left to
 * arrange.
 */
function isWorthAuthoring(opts: {
  descriptor: ConfigDescriptor;
  originRel: string;
  originContent: unknown;
}): boolean {
  const seedWhen = opts.descriptor.requiresAuthoredOverride?.seedWhen;
  if (!seedWhen) return true;
  if (!isPlainObject(opts.originContent)) {
    // Every origin this pass reads was rendered by `renderOriginJsonc` as a JSON
    // object. A non-object means the file on disk is not the artifact we wrote,
    // so the descriptor's predicate would be answering about the wrong thing.
    throw new Error(
      `seedAuthoredOverrides: config/${opts.originRel} does not parse to a JSON object, so its descriptor's seedWhen() has nothing to read.`,
    );
  }
  return seedWhen(opts.originContent);
}

function remarkMarkerLines(
  descriptor: ConfigDescriptor,
  delta: string | null,
): string[] {
  if (delta) {
    return [
      `${REVIEW_MARKER} — ${delta}`,
      "// Place the new entries deliberately, then delete this @review line.",
    ];
  }
  // No computable delta (an unexpected body shape, or a change that isn't an
  // entry set) — say so generically and re-state the descriptor's own guidance.
  const guidance = descriptor.requiresAuthoredOverride?.guidance ?? [];
  return [
    `${REVIEW_MARKER} — the defaults changed under this file. Review the values below, then delete this @review line.`,
    ...guidance.map((g) => `// ${g}`),
  ];
}

const MAX_DELTA_DEPTH = 6;
const MAX_LISTED_DELTA = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The identity of one catalog entry inside a config document. Best-effort and
 * **prose-only** — it feeds the marker's guidance line, never a gate — so an
 * unrecognized shape degrades to "no delta computed", never to a wrong file.
 *
 * A node that discriminates itself with a `type` is authoring structure (a group
 * header, a spacer) rather than a reference to a contributed entry: it exists
 * only in the override, so keying it would report a phantom removal.
 */
function entryKeyOf(node: Record<string, unknown>): string | null {
  if (typeof node.type === "string") return null;
  for (const key of ["item", "id", "name"]) {
    const v = node[key];
    if (typeof v === "string") return v;
  }
  return null;
}

function collectEntryKeys(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > MAX_DELTA_DEPTH || value === null || typeof value !== "object")
    return;
  if (Array.isArray(value)) {
    for (const el of value) {
      if (typeof el === "string") out.add(el);
      else if (isPlainObject(el)) {
        const key = entryKeyOf(el);
        if (key !== null) out.add(key);
        collectEntryKeys(el, out, depth + 1);
      }
    }
    return;
  }
  for (const v of Object.values(value)) collectEntryKeys(v, out, depth + 1);
}

/**
 * The entry-set delta between the freshly generated origin and the committed
 * override, as one sentence for the marker — "what moved under this file".
 *
 * Compared field-by-field over the fields the two documents SHARE: a scoped
 * `@app/<id>/` file is a partial delta of the base, so fields it doesn't carry
 * are not absences to report. Returns null when nothing entry-shaped differs.
 */
function catalogDelta(
  originContent: unknown,
  overrideContent: unknown,
): string | null {
  if (!isPlainObject(originContent) || !isPlainObject(overrideContent))
    return null;

  const originKeys = new Set<string>();
  const overrideKeys = new Set<string>();
  for (const [field, overrideValue] of Object.entries(overrideContent)) {
    if (!(field in originContent)) continue;
    collectEntryKeys(overrideValue, overrideKeys);
    collectEntryKeys(originContent[field], originKeys);
  }

  const parts = [
    ...[...originKeys].filter((k) => !overrideKeys.has(k)).map((k) => `+${k}`),
    ...[...overrideKeys].filter((k) => !originKeys.has(k)).map((k) => `-${k}`),
  ];
  if (parts.length === 0) return null;

  const shown = parts.slice(0, MAX_LISTED_DELTA);
  const more = parts.length - shown.length;
  return `the catalog changed under this file: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
}

/**
 * Re-stamp + re-mark one existing override iff its hash went stale. Returns true
 * when the file was rewritten.
 */
async function remarkIfStale(opts: {
  filePath: string;
  descriptor: ConfigDescriptor;
  originHash: string;
  originContent: unknown;
}): Promise<boolean> {
  const raw = readFileSync(opts.filePath, "utf8");
  // Already marked → the gate is open and its guidance is the author's to act
  // on. Rewriting it would clobber a marker they may have already edited.
  if (hasReviewMarker(raw)) return false;

  const match = CONFIG_HASH_RE.exec(raw);
  // A hashless override is corrupt, not stale — `config-origins-in-sync` says so
  // by name. Minting a header here would repair it silently, so leave it be.
  if (!match) return false;
  if (match[1]! === opts.originHash) return false;

  const body = raw.slice(match[0].length);
  const delta = catalogDelta(opts.originContent, parseJsonc(body) as unknown);
  await writeGenerated({
    file: opts.filePath,
    content: renderHeaderedFile(
      opts.originHash,
      opts.descriptor,
      remarkMarkerLines(opts.descriptor, delta),
      body,
    ),
  });
  return true;
}

/**
 * The whole seeding pass over an already-resolved descriptor set — the pure
 * filesystem half, split out so it is testable against a scratch `config/` tree
 * without the repo-wide barrel walk discovery needs.
 *
 * Must run AFTER the origin write pass: it reads each origin's hash and body
 * from DISK rather than re-deriving them from the render map, because origins are
 * written on-diff — the render map is not the set of files that changed, so
 * re-deriving would miss every already-committed origin.
 */
export async function applyAuthoredOverrideSeeding(opts: {
  configDir: string;
  descriptorsByOriginRel: Map<string, ConfigDescriptor>;
}): Promise<AuthoredOverrideSeedResult> {
  const { configDir } = opts;
  const seeded: string[] = [];
  const remarked: string[] = [];

  for (const [originRel, descriptor] of opts.descriptorsByOriginRel) {
    if (!descriptor.requiresAuthoredOverride) continue;

    const owner = configFileOwner(originRel);
    if (!owner) {
      throw new Error(
        `seedAuthoredOverrides: cannot resolve the owning descriptor path of "${originRel}".`,
      );
    }

    const originPath = join(configDir, originRel);
    if (!existsSync(originPath)) {
      // Discovery is shared with the origin generator, so by the time seeding
      // runs every live descriptor has its origin on disk. A gap means seeding
      // was wired before the origin pass — loud, not silently skipped.
      throw new Error(
        `seedAuthoredOverrides: config/${originRel} does not exist — the origin generation pass must run first.`,
      );
    }
    const originRaw = readFileSync(originPath, "utf8");
    const originMatch = CONFIG_HASH_RE.exec(originRaw);
    if (!originMatch) {
      throw new Error(
        `seedAuthoredOverrides: config/${originRel} carries no // @hash header.`,
      );
    }
    const originHash = originMatch[1]!;
    const originBody = originRaw.slice(originMatch[0].length);
    const originContent = parseJsonc(originBody) as unknown;

    // The BASE override is the mandatory one. Seed it when missing AND the
    // descriptor says there is something to arrange; otherwise it is an authored
    // file and only ever gets re-marked.
    //
    // A skipped seed leaves NO trace on disk — no empty file, no marker — and the
    // descriptor stays live, so `pruneOrphanedConfigFiles` still protects any
    // override that already exists. The next build re-asks: the moment the
    // default stops being vacuous, the file is seeded and the review is owed then,
    // when it is worth something.
    const baseRel = owner.hier
      ? `${owner.hier}/${owner.name}.jsonc`
      : `${owner.name}.jsonc`;
    const basePath = join(configDir, baseRel);
    if (!existsSync(basePath)) {
      if (isWorthAuthoring({ descriptor, originRel, originContent })) {
        await writeGenerated({
          file: basePath,
          content: renderHeaderedFile(
            originHash,
            descriptor,
            seedMarkerLines(descriptor),
            originBody,
          ),
        });
        seeded.push(baseRel);
      }
    } else if (
      await remarkIfStale({
        filePath: basePath,
        descriptor,
        originHash,
        originContent,
      })
    ) {
      remarked.push(baseRel);
    }

    // Scoped `@app/<id>/` files are OPTIONAL per-app deltas — never seeded. But
    // an existing one anchors its `// @hash` to the BASE origin (no scoped origin
    // is ever committed), so it goes stale on the same event and owes the same
    // review.
    const appDir = join(configDir, owner.hier, APP_SCOPE_DIR);
    if (!existsSync(appDir)) continue;
    for (const entry of readdirSync(appDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const scopedPath = join(appDir, entry.name, `${owner.name}.jsonc`);
      if (!existsSync(scopedPath)) continue;
      if (
        await remarkIfStale({
          filePath: scopedPath,
          descriptor,
          originHash,
          originContent,
        })
      ) {
        remarked.push(
          `${owner.hier}/${APP_SCOPE_DIR}/${entry.name}/${owner.name}.jsonc`,
        );
      }
    }
  }

  return { seeded, remarked };
}

/**
 * Seed / re-mark every mandatory override under `<root>/config`. Build-only —
 * see the deliberate omission from `regenerateManifestCodegen` (regen-pipeline.ts).
 */
export async function seedAuthoredOverrides(opts: {
  root: string;
}): Promise<AuthoredOverrideSeedResult> {
  return await applyAuthoredOverrideSeeding({
    configDir: join(opts.root, "config"),
    descriptorsByOriginRel: await loadConfigDescriptorsByOriginPath({
      root: opts.root,
    }),
  });
}

/**
 * Every committed override under `<root>/config` that still carries the review
 * marker (paths relative to `config/`). The post-commit assertion in
 * `regen-generated` reads this: a marker in a tree about to be amended into a
 * landing commit means an unreviewed default is one `git add` away.
 */
export function listReviewMarkedOverrides(opts: { root: string }): string[] {
  const configDir = join(opts.root, "config");
  if (!existsSync(configDir)) return [];
  const onDisk: string[] = [];
  walkJsoncFiles(configDir, configDir, onDisk);
  return onDisk.filter(
    (rel) =>
      // Only OVERRIDES are ever marked; the generated `.origin` / transient
      // `.ancestor` siblings are not authored, so they are not review surfaces.
      !rel.endsWith(".origin.jsonc") &&
      !rel.endsWith(".ancestor.jsonc") &&
      hasReviewMarker(readFileSync(join(configDir, rel), "utf8")),
  );
}
