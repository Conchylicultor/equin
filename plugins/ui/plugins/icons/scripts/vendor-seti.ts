#!/usr/bin/env bun
/**
 * Vendors the Seti file-type glyphs (jesseweed/seti-ui, MIT) as an Iconify set.
 *
 * Fetches the commit pinned in `shared/seti.ts` (`SETI_SOURCE`), checks that its
 * license is still MIT, normalizes every `icons/*.svg` to a one-colour glyph
 * (`normalizeSetiSvg`) and writes:
 *
 * - `server/internal/seti/seti.json` — the Iconify JSON the sprite server reads;
 * - `server/internal/seti/LICENSE.txt` — the upstream license, verbatim;
 * - `core/seti-names.generated.ts` — the `SetiName` union `seti()` accepts.
 *
 * To upgrade: change `SETI_SOURCE.commit` and rerun. The `icons:seti-in-sync`
 * check fails until you do.
 *
 * Usage: ./equin run plugins/ui/plugins/icons/scripts/vendor-seti.ts
 */
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { writeGenerated } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  getWorktreeRoot,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import {
  SETI_JSON_REL_PATH,
  SETI_LICENSE_REL_PATH,
  SETI_NAMES_REL_PATH,
  SETI_SOURCE,
  buildSetiSet,
  renderSetiNames,
} from "../shared";

const MIT_GRANT =
  "Permission is hereby granted, free of charge, to any person obtaining";

const root = await getWorktreeRoot();
const work = await mkdtemp(join(tmpdir(), "seti-vendor-"));
try {
  const url = `https://codeload.github.com/${SETI_SOURCE.repo}/tar.gz/${SETI_SOURCE.commit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[seti] GET ${url} → ${res.status}`);
  const tarball = join(work, "seti.tgz");
  await writeFile(tarball, new Uint8Array(await res.arrayBuffer()));
  const src = join(work, "src");
  await mkdir(src);
  await spawnExpectOk(
    ["tar", "-xzf", tarball, "-C", src, "--strip-components=1"],
    { timeoutMs: 60_000 },
  );

  const license = await readFile(join(src, "LICENSE.md"), "utf8");
  if (!license.includes(MIT_GRANT)) {
    throw new Error(
      `[seti] ${SETI_SOURCE.repo}@${SETI_SOURCE.commit} is no longer MIT-licensed — review before vendoring`,
    );
  }

  const icons = new Map<string, string>();
  for (const file of (await readdir(join(src, "icons"))).sort()) {
    if (!file.endsWith(".svg")) continue;
    icons.set(
      file.slice(0, -4),
      await readFile(join(src, "icons", file), "utf8"),
    );
  }
  const set = buildSetiSet(icons);

  const jsonPath = join(root, SETI_JSON_REL_PATH);
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(set, null, 1)}\n`);
  await writeFile(join(root, SETI_LICENSE_REL_PATH), license);
  await writeGenerated({
    file: join(root, SETI_NAMES_REL_PATH),
    content: renderSetiNames(Object.keys(set.icons)),
  });
  console.log(
    `Vendored ${icons.size} Seti glyphs from ${SETI_SOURCE.repo}@${SETI_SOURCE.commit}`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
