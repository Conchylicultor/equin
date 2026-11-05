// One worker thread of the pooled record workers (`cli/`'s
// `createPooledRecordWorkers`): answers each request by running the record job
// it names — importing the module that defines it on first use — exactly as
// the calling process would run it in-process.

import { serveThreadPool } from "@plugins/packages/plugins/thread-pool/cli";
import { runRecordJobRequest, type RecordJobRequest } from "../core";

// The module a request names is loaded here, by computed path: this entry is
// run by path in a worker thread, never imported, so no other closure carries
// the load (see `runRecordJobRequest`).
serveThreadPool<RecordJobRequest, unknown>((req) =>
  runRecordJobRequest(req, (module) => import(module)),
);
