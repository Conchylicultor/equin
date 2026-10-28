// Renders a prototype fixture's thumbnails — every version of every prototype
// in it — with the gallery's own renderer, into the fixture's
// `thumbnails/<fingerprint>.png`, and drops the PNGs no version names. A host
// with no renderer (a browser host) shows only the committed pictures, so a
// fixture's owner re-runs this after editing it; its
// `prototypeFixtureThumbnailsCheck` fails the build until then.
//
// Run: `./equin run plugins/apps/plugins/prototypes/plugins/fixtures/scripts/render-fixture-thumbnails.ts --fixture <dir>`
// (`<dir>` holds the fixture's `prototypes/` and `thumbnails/`, from the repo root).
//
// Each version's folder is laid out in a temp tree (one folder per version,
// named `<id>.v<N>` — the renderer reads a folder, the fingerprint its files,
// never its name), then `./equin prototype thumbnails` renders the tree.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import {
  auditPrototypeFixtureThumbnails,
  parsePrototypeTree,
  prototypeFixtureDataOf,
  prototypeFixtureVersionFingerprint,
  type PrototypeFixtureData,
} from "../core";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { fixture: { type: "string" } },
  strict: true,
});
if (values.fixture === undefined)
  throw new Error(
    "--fixture <dir> is required: the directory holding the fixture's prototypes/ and thumbnails/",
  );
const fixtureDir = resolve(REPO_ROOT, values.fixture);
const thumbnailsDir = join(fixtureDir, "thumbnails");

/** The fixture's `prototypes/` and `thumbnails/` off disk (machine's `readPrototypeFixtureDir`, which a script cannot import). */
function readFixture(): PrototypeFixtureData {
  if (!existsSync(join(fixtureDir, "prototypes")))
    throw new Error(`${fixtureDir} has no prototypes/ folder`);
  const files: Record<string, Uint8Array> = {};
  for (const folder of ["prototypes", "thumbnails"]) {
    const root = join(fixtureDir, folder);
    if (!existsSync(root)) continue;
    for (const rel of readdirSync(root, { recursive: true }) as string[])
      if (statSync(join(root, rel)).isFile())
        files[`${folder}/${rel.split(sep).join("/")}`] = new Uint8Array(
          readFileSync(join(root, rel)),
        );
  }
  return prototypeFixtureDataOf(files);
}

const { prototypes } = parsePrototypeTree(readFixture().tree);
const tree = mkdtempSync(join(tmpdir(), "fixture-thumbnails-"));
try {
  for (const p of prototypes)
    for (const v of p.versions) {
      const folder = join(tree, `${p.id}.v${v.n}`);
      mkdirSync(folder);
      for (const [name, text] of Object.entries(v.files))
        writeFileSync(join(folder, name), text);
    }
  const child = Bun.spawnSync(
    [
      join(REPO_ROOT, "equin"),
      "prototype",
      "thumbnails",
      tree,
      "--out",
      thumbnailsDir,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (child.exitCode !== 0)
    throw new Error(`./equin prototype thumbnails exited ${child.exitCode}`);
} finally {
  rmSync(tree, { recursive: true, force: true });
}
const rendered = readFixture();
const { wanted, unused } = auditPrototypeFixtureThumbnails(
  parsePrototypeTree(rendered.tree),
  rendered.thumbnails,
);
for (const png of unused) {
  rmSync(join(thumbnailsDir, png));
  console.log(`dropped unused ${png}`);
}
console.log(
  `${wanted.size} thumbnails for ${prototypes.length} prototypes in ${thumbnailsDir}`,
);
// Every version named one: a fingerprint the renderer did not write is loud.
for (const p of prototypes)
  for (const v of p.versions)
    if (
      !existsSync(
        join(thumbnailsDir, `${prototypeFixtureVersionFingerprint(v)}.png`),
      )
    )
      throw new Error(`${p.id} v${v.n} was not rendered`);
