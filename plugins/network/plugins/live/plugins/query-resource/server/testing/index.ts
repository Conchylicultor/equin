// The bounded compiler WITHOUT registering, for suites that read its output
// against their own `db`: `network/live`'s tests of the window / point
// descriptors its collections mint and of `serveCollection`'s derived specs,
// and the page editor's block-doc store. Shipping code registers through
// `windowQueryResource`.
export { compileWindowQuery } from "../internal/compile-window";
// The `all` compiler (`compileAllCollection`, also the public barrel's — its
// shipping caller is network/live's `serveCollection`): the compile-SQL golden
// and tasks-core's parity oracle run it against their own `db`, over
// declarations no collection serves.
export { compileAllCollection } from "../internal/compile-alias";
// A `QueryDb` fake rendering every query through drizzle's real dialect, for
// suites reading which SQL (and which relations) each compiled shape runs.
export { recordingQueryDb } from "./recording-db";
export type { RecordedQuery } from "./recording-db";
