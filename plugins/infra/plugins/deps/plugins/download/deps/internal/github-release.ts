import { z } from "zod";
import {
  download,
  type DownloadDerive,
  type DownloadFile,
  type DownloadSource,
} from "./download";

/**
 * The updater that moves every {@link githubReleaseDownload}'s pin
 * (`download/plugins/github-release-updater`). Spelled here, where the source
 * names it, so a declaration and its updater cannot disagree.
 */
export const GITHUB_RELEASE_UPDATER_ID = "github-release";

/** `owner/name` of a GitHub repository. */
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * One release asset of a GitHub repository, pinned: which release (`tag`,
 * published at `publishedAt`), which asset (`asset`, a name template where
 * `{tag}` stands for the tag, so the next release's asset is found by the same
 * pattern) and the bytes it must hash to (`sha256`, as GitHub's own asset
 * digest reports it). Kept in a JSON file beside the declaration — its
 * `pinFile` — which the updater rewrites; nothing else names the release.
 */
export const GithubReleasePinSchema = z
  .object({
    repo: z.string().regex(REPO, "owner/name"),
    asset: z
      .string()
      .includes("{tag}", { message: "the asset template names {tag}" }),
    tag: z.string().min(1),
    publishedAt: z.string().datetime(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type GithubReleasePin = z.infer<typeof GithubReleasePinSchema>;

/** The asset's name for `tag`: the template with `{tag}` filled in. */
export function githubReleaseAssetName(asset: string, tag: string): string {
  return asset.replaceAll("{tag}", tag);
}

/** Where GitHub serves one release asset. */
export function githubReleaseAssetUrl(
  pin: Pick<GithubReleasePin, "repo" | "asset" | "tag">,
): string {
  const name = githubReleaseAssetName(pin.asset, pin.tag);
  return `https://github.com/${pin.repo}/releases/download/${encodeURIComponent(pin.tag)}/${encodeURIComponent(name)}`;
}

/** A download kept current by the `github-release` updater. */
export interface GithubReleaseDownloadSource extends DownloadSource {
  readonly updater: typeof GITHUB_RELEASE_UPDATER_ID;
  /** The pin, as parsed, and the repo-relative JSON file it was read from. */
  readonly release: {
    readonly pin: GithubReleasePin;
    readonly pinFile: string;
  };
}

/**
 * A `download` of one GitHub release asset, kept current by the
 * `github-release` updater (`./equin deps upgrade github-release`, and the
 * weekly Dependency upgrades detection): the updater asks GitHub for the
 * repository's newest release past its cooldown and rewrites `pinFile` with
 * its tag, publish instant and asset digest. A moved pin is a new identity,
 * so a new install beside the old one, like any download pin.
 *
 * `pin` is the JSON file's contents (`import pin from "./x.pin.json"`) and
 * `pinFile` its repo-relative path — the updater reads and writes that file
 * and refuses to move a pin whose file says something else.
 */
export function githubReleaseDownload(opts: {
  /** The asset's name inside `env/`. */
  name: string;
  pin: unknown;
  pinFile: string;
  derive?: DownloadDerive;
  timeoutMs?: number;
}): GithubReleaseDownloadSource {
  const pin = GithubReleasePinSchema.parse(opts.pin);
  if (opts.pinFile.startsWith("/") || !opts.pinFile.endsWith(".json")) {
    throw new Error(
      `githubReleaseDownload: pinFile ${JSON.stringify(opts.pinFile)} must be a repo-relative .json path`,
    );
  }
  const file: DownloadFile = {
    name: opts.name,
    url: githubReleaseAssetUrl(pin),
    sha256: pin.sha256,
  };
  return {
    ...download({
      files: [file],
      ...(opts.derive === undefined ? {} : { derive: opts.derive }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    }),
    updater: GITHUB_RELEASE_UPDATER_ID,
    release: { pin, pinFile: opts.pinFile },
  };
}

/** Whether a declared source is a {@link githubReleaseDownload}. */
export function isGithubReleaseDownload(source: {
  readonly kind: string;
  readonly updater?: string;
}): source is GithubReleaseDownloadSource {
  return (
    source.kind === "download" && source.updater === GITHUB_RELEASE_UPDATER_ID
  );
}
