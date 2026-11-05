// One worker thread of the pooled record workers (`cli/`'s
// `createPooledRecordWorkers`): answers each request by running the record job
// it names — importing the module that defines it on first use — exactly as
// the calling process would run it in-process.

import { serveThreadPool } from "@plugins/packages/plugins/thread-pool/cli";
import { runRecordJobRequest, type RecordJobRequest } from "../core";

serveThreadPool<RecordJobRequest, unknown>(runRecordJobRequest);
