import { serveCollection } from "@plugins/network/plugins/live/server";
import { testCaseFailures, testFileRuns, testFileStatus } from "../../core";
import { _testCaseFailures, _testFileResults, _testFileStatus } from "./tables";

// Every checkout file's status: the page's summary and tree.
export const testFileStatusServed = serveCollection(testFileStatus, {
  from: _testFileStatus,
});

// One file's recorded results, newest first: the detail pane's Recent runs.
export const testFileRunsServed = serveCollection(testFileRuns, {
  from: _testFileResults,
});

// One run's failing cases of one file: the detail pane's Failing cases.
export const testCaseFailuresServed = serveCollection(testCaseFailures, {
  from: _testCaseFailures,
});
