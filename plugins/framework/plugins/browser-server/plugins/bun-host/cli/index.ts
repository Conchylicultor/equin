// A host-process library, not a command (no default export): a browser host's
// graph as a Bun process boots it. A `cli/` barrel because it reads the repo's
// files and must reach the providers' `server` barrels — the one barrel a
// `bin/` may import that may do both.
export {
  diskMigrationList,
  withDiskProviders,
} from "./internal/disk-providers";
