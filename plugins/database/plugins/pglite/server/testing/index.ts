// The PGlite driver itself, for a suite that opens a database the way a
// browser host does — on a storage of its own (a directory standing for
// IndexedDB, reopened to stand for a reload) — and provides it as the
// `DatabaseDriver` with `withHostServices`.
export { createPgliteDriver } from "../internal/pglite-driver";
