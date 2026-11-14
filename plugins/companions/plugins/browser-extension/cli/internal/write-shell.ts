import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { createSha256 } from "@plugins/packages/plugins/string-hash/core";
import { LOGO_FILES } from "@plugins/ui/plugins/logo/core";
import {
  namespaceUrl,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { EXTENSION_PUBLIC_KEY } from "../../core";
import {
  browserExtensionRoot,
  SHELL_DIGEST_FILE,
  SHELL_FOLDER,
} from "../../data-dirs";

/** The shell's sources, repo-relative. */
const SHELL_SOURCES =
  "plugins/companions/plugins/browser-extension/browser-extension";

/** The icons the manifest names, each from the generated logo PNG at that path's end. */
const ICONS: readonly { name: string; logo: string }[] = [
  { name: "icon-16.png", logo: "/icon_16x16.png" },
  { name: "icon-32.png", logo: "/icon_32x32.png" },
  { name: "icon-128.png", logo: "/icon_512x512.png" },
];

export type ShellWrite =
  | { kind: "unchanged"; path: string; digest: string }
  | { kind: "written"; path: string; digest: string };

/**
 * Build the extension shell that frames `namespace` into its root
 * (`browserExtensionRoot`): main's into the installed data dir, a worktree's
 * beside its build artifacts.
 *
 * The shell is a function of its sources, the logo, the extension key and the
 * framed origin; its digest is a hash of every file it ships. When the digest
 * matches what is there, nothing is written (so the backend watching it hears
 * nothing and no popup reloads). Otherwise the whole folder is staged beside
 * and swapped in by rename, then the digest file is written — last, because
 * it is what the backend watches and what tells an open popup to reload.
 */
export async function writeExtensionShell(opts: {
  root: string;
  namespace: Namespace;
}): Promise<ShellWrite> {
  const files = await shellFiles(opts.root, namespaceUrl(opts.namespace));

  const hasher = createSha256();
  for (const [name, bytes] of files) hasher.update(name).update(bytes);
  const digest = hasher.hex();
  const html = files
    .get("popup.html")
    ?.toString()
    .replace("{{SHELL_DIGEST}}", digest);
  if (html === undefined) throw new Error("the shell has no popup.html");
  files.set("popup.html", Buffer.from(html));

  const root = browserExtensionRoot(opts.namespace);
  const shell = join(root, SHELL_FOLDER);
  const digestFile = join(root, SHELL_DIGEST_FILE);
  if (
    existsSync(join(shell, "manifest.json")) &&
    existsSync(digestFile) &&
    (await readFile(digestFile, "utf8")).trim() === digest
  )
    return { kind: "unchanged", path: shell, digest };

  await mkdir(root, { recursive: true });
  const staged = join(root, `.${SHELL_FOLDER}-${randomUUID()}`);
  await mkdir(staged);
  for (const [name, bytes] of files) await writeFile(join(staged, name), bytes);
  const old = join(root, `.${SHELL_FOLDER}-old-${randomUUID()}`);
  if (existsSync(shell)) await rename(shell, old);
  await rename(staged, shell);
  await rm(old, { recursive: true, force: true });
  const digestStaged = `${digestFile}.${randomUUID()}`;
  await writeFile(digestStaged, `${digest}\n`);
  await rename(digestStaged, digestFile);
  return { kind: "written", path: shell, digest };
}

/** Every file the shell ships, by name — `popup.html` still holding its digest placeholder. */
async function shellFiles(
  repoRoot: string,
  origin: string,
): Promise<Map<string, Buffer>> {
  const sources = join(repoRoot, SHELL_SOURCES);
  const files = new Map<string, Buffer>();

  const built = await Bun.build({
    entrypoints: [join(sources, "popup.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  const [bundle] = built.outputs;
  if (!built.success || bundle === undefined || built.outputs.length !== 1)
    throw new Error(
      `the extension shell did not bundle: ${built.logs.map(String).join("\n")}`,
    );
  files.set("popup.js", Buffer.from(await bundle.text()));

  // The key is the core's, so the id Chrome derives is the one the page trusts.
  const manifest = JSON.parse(
    await readFile(join(sources, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  files.set(
    "manifest.json",
    Buffer.from(
      `${JSON.stringify({ ...manifest, key: EXTENSION_PUBLIC_KEY }, null, 2)}\n`,
    ),
  );

  const html = await readFile(join(sources, "popup.html"), "utf8");
  if (!html.includes("{{ORIGIN}}") || !html.includes("{{SHELL_DIGEST}}"))
    throw new Error("popup.html lost its {{ORIGIN}} / {{SHELL_DIGEST}} slots");
  files.set("popup.html", Buffer.from(html.replace("{{ORIGIN}}", origin)));

  for (const icon of ICONS) {
    const matches = LOGO_FILES.filter(
      (f) => f.kind === "png" && f.path.endsWith(icon.logo),
    );
    const [logo] = matches;
    if (logo === undefined || matches.length !== 1)
      throw new Error(
        `the logo has ${matches.length} PNGs ending ${icon.logo} for ${icon.name}, not one`,
      );
    files.set(icon.name, await readFile(join(repoRoot, logo.path)));
  }
  return files;
}
