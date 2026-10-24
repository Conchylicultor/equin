/**
 * Dev script: fetches the Google Fonts family catalog and writes
 * web/internal/google-fonts-catalog.json.
 *
 * Usage:
 *   ./equin run plugins/ui/plugins/tokens/plugins/font-family/plugins/google-fonts/scripts/fetch-catalog.ts
 *
 * Why a committed snapshot: the loader has to answer "can Google actually serve
 * this family name?" for arbitrary names arriving from third-party themes. That
 * question has exactly one authoritative answer and it is published here, so we
 * snapshot it rather than maintaining a hand-written list of the *complement*
 * (system font names), which is an open, unbounded set.
 *
 * Staleness is graceful: a family added to Google Fonts after the snapshot is
 * simply not loaded, and the text falls back — it never hangs. Re-run this
 * script to refresh.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(
  __dirname,
  "../web/internal/google-fonts-catalog.json",
);

const METADATA_URL = "https://fonts.google.com/metadata/fonts";

/**
 * Floor for a plausible catalog. The real list is ~1,900 families; anything far
 * below that means the endpoint changed shape or served a partial response, and
 * committing it would silently shrink the allowlist (fonts stop loading with no
 * error anywhere). Fail loud instead of writing a truncated file.
 */
const MIN_PLAUSIBLE_FAMILIES = 1000;

interface FamilyMetadata {
  family: string;
}

interface Metadata {
  familyMetadataList: FamilyMetadata[];
}

async function fetchFamilies(): Promise<string[]> {
  console.log(`Fetching ${METADATA_URL} ...`);
  const res = await fetch(METADATA_URL);
  if (!res.ok) {
    throw new Error(`Catalog fetch failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as Metadata;
  if (!Array.isArray(json.familyMetadataList)) {
    throw new Error(
      "Unexpected metadata shape: expected a `familyMetadataList` array. " +
        "The endpoint has changed — update this script.",
    );
  }

  const families = [
    ...new Set(
      json.familyMetadataList
        .map((f) => f.family)
        .filter((f): f is string => typeof f === "string" && f !== ""),
    ),
  ].sort((a, b) => a.localeCompare(b));

  if (families.length < MIN_PLAUSIBLE_FAMILIES) {
    throw new Error(
      `Only ${families.length} families parsed (expected >= ${MIN_PLAUSIBLE_FAMILIES}). ` +
        "Refusing to write a truncated catalog.",
    );
  }

  return families;
}

async function main(): Promise<void> {
  const families = await fetchFamilies();

  const json = `${JSON.stringify(
    { generatedAt: new Date().toISOString().slice(0, 10), families },
    null,
    2,
  )}\n`;
  await Bun.write(OUTPUT_PATH, json);

  const sizeKb = (Buffer.byteLength(json) / 1024).toFixed(0);
  console.log(
    `\nWrote ${OUTPUT_PATH}\n  Families: ${families.length}\n  Size: ${sizeKb} KB`,
  );
}

await main();
