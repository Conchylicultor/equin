// ─── Refresh the vendored LiteLLM snapshot ────────────────────────────────────
//
//   ./equin run plugins/stats/plugins/cost/scripts/refresh-litellm-fallback.ts
//
// Fetches LiteLLM's table through the server's own `fetchPriceTable` (so the
// snapshot is exactly what `parseLiteLlmTable` produces) and merges it OVER the
// current snapshot with `mergePriceTable` — the floor never loses a key, the
// same rule the persisted table follows. Rewrites `litellm-fallback.json` one
// model per line, keys sorted, so a refresh diffs as the rows that moved.
//
// Run it when a model joins `BASELINE_MODELS`: the "every baseline model
// resolves by exact key" test fails until the snapshot carries it.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadFallbackPriceTable } from "../server/internal/litellm-fallback";
import {
  fetchPriceTable,
  mergePriceTable,
} from "../server/internal/price-table";

const SNAPSHOT = join(
  import.meta.dir,
  "../server/internal/litellm-fallback.json",
);

const before = await loadFallbackPriceTable();
const table = mergePriceTable(before, await fetchPriceTable());

const keys = Object.keys(table.models).sort();
const rows = keys.map(
  (key) => `    ${JSON.stringify(key)}: ${JSON.stringify(table.models[key])}`,
);
await writeFile(
  SNAPSHOT,
  `{\n  "fetchedAt": ${table.fetchedAt},\n  "models": {\n${rows.join(",\n")}\n  }\n}\n`,
);

const added = keys.filter((key) => !(key in before.models));
console.log(
  `${SNAPSHOT}: ${keys.length} models (${added.length} new), fetched ` +
    new Date(table.fetchedAt).toISOString(),
);
for (const key of added) console.log(`  + ${key}`);
