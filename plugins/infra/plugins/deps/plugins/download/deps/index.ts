// The download installer kind of infra/deps, host-only like the engine: a
// declaration of pinned files (`download`, in a feature's `deps/index.ts`) and
// the path of one of them once installed (`downloadedFile`, which takes a
// `Ready`).
export { download, downloadedFile } from "./internal/download";
export type {
  DownloadDerive,
  DownloadFile,
  DownloadSource,
} from "./internal/download";
// A download of one GitHub release asset whose pin (a JSON file beside the
// declaration) the `github-release` updater moves.
export {
  GITHUB_RELEASE_UPDATER_ID,
  GithubReleasePinSchema,
  githubReleaseAssetName,
  githubReleaseAssetUrl,
  githubReleaseDownload,
  isGithubReleaseDownload,
} from "./internal/github-release";
export type {
  GithubReleaseDownloadSource,
  GithubReleasePin,
} from "./internal/github-release";
