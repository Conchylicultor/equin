import { declareDataRootLayoutSync } from "@plugins/infra/plugins/paths/core";

// ── Before anything reads a path: decide where the data root is ──────────────
//
// The gateway sets the decided layout for every child it spawns
// (`gateway/dataroot.go`), but this entry decides it again from the disk: a
// gateway that predates the declaration sets nothing, and this is the root of
// the backend's own process tree — every worker and child it starts inherits
// the answer instead of reading the disk on its own thread (infra/paths
// CLAUDE.md, § The data root). A blocking read, and the sanctioned kind: it runs
// before the backend listens, as the first import of the serving entry.
declareDataRootLayoutSync();
