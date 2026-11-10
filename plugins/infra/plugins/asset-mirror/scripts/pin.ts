/**
 * Pin a mirror's files: download each from its remote and write their sha256
 * as a TypeScript module — the `files` record of a `defineAssetMirrorSource`.
 *
 *   ./equin run plugins/infra/plugins/asset-mirror/scripts/pin.ts \
 *     --base https://cdn.example.com/assets --out plugins/<p>/shared/pins.ts \
 *     --export MY_PINS [--names-json names.json] [name ...]
 *
 * `--names-json` is a JSON array of names (for a set derived from code, e.g. a
 * sampler's manifest); bare arguments add more. Run it when a mirror's file set
 * grows, or to re-pin after reviewing a remote change — a pin is the reviewed
 * bytes, so never re-pin blindly to make a mismatch go away.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    base: { type: "string" },
    out: { type: "string" },
    export: { type: "string" },
    "names-json": { type: "string" },
    concurrency: { type: "string", default: "6" },
  },
});

const base = values.base?.replace(/\/$/, "");
if (!base || !values.out || !values.export) {
  throw new Error("--base, --out and --export are required");
}
const names = [...positionals];
if (values["names-json"]) {
  const parsed: unknown = JSON.parse(
    await readFile(values["names-json"], "utf8"),
  );
  if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== "string")) {
    throw new Error(`${values["names-json"]} is not a JSON array of strings`);
  }
  names.push(...(parsed as string[]));
}
const unique = [...new Set(names)].sort();
if (unique.length === 0) throw new Error("no file names given");

const pins = new Map<string, string>();
const queue = [...unique];
async function worker(): Promise<void> {
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const url = `${base}/${name.split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    pins.set(name, createHash("sha256").update(bytes).digest("hex"));
    console.error(`${name}: ${bytes.byteLength} bytes`);
  }
}
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, () => worker()),
);

const body = unique
  .map((n) => `  ${JSON.stringify(n)}:\n    ${JSON.stringify(pins.get(n))},`)
  .join("\n");
await writeFile(
  values.out,
  `// Pinned by \`./equin run plugins/infra/plugins/asset-mirror/scripts/pin.ts\`
// from ${base} — each file's sha256, checked before the mirror stores it.
export const ${values.export} = {
${body}
} as const;
`,
);
console.error(`pinned ${unique.length} file(s) into ${values.out}`);
