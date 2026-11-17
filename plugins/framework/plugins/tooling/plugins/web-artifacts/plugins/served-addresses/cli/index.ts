// The served dist's address dir and the rule that bounds it — NOT a command
// (no default export). Shared by the dev build (`framework/cli/build`'s
// artifact pipeline), the blocker scan, and a release's `launch` binary
// (`infra/launcher/bin/launch.ts`), which serves a release from the same
// layout so a ship never deletes the files an open tab still loads.
//
// A sub-plugin of web-artifacts rather than its `cli/` barrel: that barrel
// carries the pooled vite builder, which the release launcher must not
// compile in, and nothing here is part of an artifact's address
// (`builderSourceDigest` hashes web-artifacts' `core/`).
export { retainAddresses, servedGraphOf } from "./internal/address-retention";
export { addressDirOf, publishReleaseDist } from "./internal/release-dist";
