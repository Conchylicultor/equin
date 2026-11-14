// What a page's HTML makes the browser fetch before its code can run: the
// served shell's `<link rel=modulepreload>` set plus its entry module, each
// fetched with `Accept-Encoding: br` (the precompressed sidecar the gateway
// serves to a secure-context browser) and with `identity`. Prints the file
// count, the br / raw bytes, how they split between first-party code and the
// vendor set, and the HTML and import-map sizes.
//
//   ./equin run plugins/framework/plugins/tooling/plugins/web-artifacts/scripts/measure-route-set.ts \
//     --url http://<namespace>.localhost:9000/agents [--json out.json]
//
// Chromium gets gzip, not br, over plain http://localhost — the wire bytes a
// local page load reports are gzip. br is what a deployed (https) page gets,
// and the measure the load-model redesign's numbers are in
// (research/2026-11-12-global-load-model-redesign.md §13–§14).

import { writeFileSync } from "node:fs";

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const pageUrl = arg("url");
if (pageUrl === undefined) throw new Error("--url <page url> is required");
const jsonOut = arg("json");

const htmlRes = await fetch(pageUrl, {
  headers: { "accept-encoding": "identity" },
});
if (!htmlRes.ok) throw new Error(`${pageUrl}: HTTP ${htmlRes.status}`);
const html = await htmlRes.text();
const importMap =
  /<script type="importmap">(.*?)<\/script>/s.exec(html)?.[1] ?? "";
const entry = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
if (entry === undefined) throw new Error(`${pageUrl}: no entry module script`);
const preloads = [
  ...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g),
].map((m) => m[1]!);
const urls = [...new Set([...preloads, entry])];

/** Bytes of the body as served for one Accept-Encoding, never decompressed. */
async function servedBytes(url: string, encoding: string): Promise<number> {
  const res = await fetch(new URL(url, pageUrl), {
    headers: { "accept-encoding": encoding },
    decompress: false,
  } as RequestInit);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.arrayBuffer()).byteLength;
}

// The vendor set's files live under `set.<hash>/`; everything else is
// first-party code (plugin artifacts, route chunks, the entry, the registry).
const isVendor = (url: string) => /\/artifacts\/set\.[^/]+\//.test(url);
const totals = {
  firstParty: { files: 0, br: 0, raw: 0 },
  vendor: { files: 0, br: 0, raw: 0 },
};
const queue = [...urls];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const [br, raw] = await Promise.all([
        servedBytes(url, "br"),
        servedBytes(url, "identity"),
      ]);
      const bucket = isVendor(url) ? totals.vendor : totals.firstParty;
      bucket.files++;
      bucket.br += br;
      bucket.raw += raw;
    }
  }),
);
const result = {
  url: pageUrl,
  htmlBytes: html.length,
  importMapBytes: importMap.length,
  importMapEntries:
    importMap === ""
      ? 0
      : Object.keys(
          (JSON.parse(importMap) as { imports: Record<string, string> })
            .imports,
        ).length,
  files: totals.firstParty.files + totals.vendor.files,
  br: totals.firstParty.br + totals.vendor.br,
  raw: totals.firstParty.raw + totals.vendor.raw,
  ...totals,
};
console.log(JSON.stringify(result, null, 2));
if (jsonOut !== undefined)
  writeFileSync(jsonOut, JSON.stringify(result, null, 2));
