import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  resolveRow,
  useOpenPane,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { TEST_STATUSES, testFileStatus, type TestStatus } from "../core";
import { TestsView } from "./components/tests-view";
import { FileDetail } from "./components/file-detail";

// `;status` is the summary cards' filter: in the URL, so a filtered view is
// a link.
const testsRoute = defineRoute({
  id: "debug-tests",
  segment: "tests;status",
});

export const testsPane = Pane.define({
  title: "Tests",
  route: testsRoute,
  app: debugApp,
  component: TestsBody,
});

function asStatus(value: string | undefined): TestStatus | undefined {
  return (TEST_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as TestStatus)
    : undefined;
}

function TestsBody(): ReactElement {
  const openPane = useOpenPane();
  const { status } = testsPane.useParams();
  const setParams = testsPane.useSetParams();
  const open = testFilePane.useRouteEntry()?.params;
  return (
    <PaneChrome pane={testsPane}>
      <Scroll>
        <TestsView
          status={asStatus(status)}
          onStatus={(s) => setParams({ status: s })}
          selectedPath={open?.path}
          linkTo={(path) =>
            openPane.to(testFilePane, { path }, { mode: "push" })
          }
        />
      </Scroll>
    </PaneChrome>
  );
}

function useResolveFile({ path }: { path: string }): ResolveResult {
  return resolveRow(useLive(testFileStatus, { id: path }));
}

// Detail (/debug/tests/test-file/<path>): one test file.
export const testFilePane = Pane.define({
  title: "Test file",
  route: defineRoute({
    id: "debug-test-file",
    segment: "test-file/:path*",
    parent: testsRoute,
  }),
  app: debugApp,
  useResolve: useResolveFile,
  component: TestFileBody,
});

function TestFileBody(): ReactElement {
  const { path } = testFilePane.useParams();
  return (
    <PaneChrome pane={testFilePane}>
      <Scroll>
        <FileDetail path={path} />
      </Scroll>
    </PaneChrome>
  );
}
